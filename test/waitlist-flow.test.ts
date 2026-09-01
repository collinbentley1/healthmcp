import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { WaitlistConfirmationCodec } from "../src/waitlist-confirmation.ts";
import { MemoryWaitlistStore, sha256, submitWaitlist } from "../src/waitlist.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CONFIG = {
  ...getRuntimeConfig({
    CANONICAL_HOST: "medlock.ai",
    IDENTITY_PLATFORM_AUDIENCE: "medlock-1025243085",
    IDENTITY_PLATFORM_CONTINUE_URL: "https://medlock.ai/api/waitlist/confirm",
    RECAPTCHA_PROJECT_ID: "medlock-1025243085",
    RECAPTCHA_SITE_KEY: "public_site_key_12345678901234567890",
    WAITLIST_BACKEND: "memory",
    WAITLIST_IDENTITY_KEYSET: Buffer.from(KEY).toString("base64url"),
  }),
  // Production configuration can only enable this with Firestore. Unit tests
  // inject a single-process CAS-capable memory store explicitly.
  waitlistActivationEnabled: true,
};

type HarnessOptions = {
  readonly assess?: (token: string, action: string) => Promise<unknown>;
  readonly quota?: { consume: (rules: readonly { key: string }[]) => Promise<{ allowed: boolean; retryAfterSeconds: number }> };
  readonly send?: (email: string, linkState: string) => Promise<void>;
  readonly store?: MemoryWaitlistStore;
  readonly verify?: (oobCode: string) => Promise<string>;
};

function harness(options: HarnessOptions = {}) {
  const store = options.store ?? new MemoryWaitlistStore();
  const sent: { email: string; linkState: string }[] = [];
  const assessed: { action: string; token: string }[] = [];
  const verified: string[] = [];
  const quotaCalls: string[][] = [];
  const codec = new WaitlistConfirmationCodec([KEY]);
  const handler = createHandler({
    config: CONFIG,
    confirmationCodec: codec,
    identityDispatcher: {
      sendSignInLink: async (email, linkState) => {
        sent.push({ email, linkState });
        await options.send?.(email, linkState);
      },
      verifyEmailLink: async (oobCode) => {
        verified.push(oobCode);
        return await (options.verify?.(oobCode) ?? Promise.resolve("member@example.com"));
      },
    },
    monotonicNow: () => 1_000,
    now: () => new Date(NOW),
    recaptcha: {
      assess: async (token, action) => {
        assessed.push({ action, token });
        await options.assess?.(token, action);
        return { action, hostname: "medlock.ai", score: 0.9 };
      },
    },
    sleep: async () => undefined,
    waitlistIdentitySecrets: [KEY],
    waitlistQuota: options.quota ?? {
      consume: async (rules) => {
        quotaCalls.push(rules.map((rule) => rule.key));
        return { allowed: true, retryAfterSeconds: 0 };
      },
    },
    waitlistStore: store,
  });
  return { assessed, codec, handler, quotaCalls, sent, store, verified };
}

function join(email: string, token: string = crypto.randomUUID()): Request {
  return new Request("http://localhost/api/waitlist", {
    body: JSON.stringify({ email, recaptchaToken: token, source: "site" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function observed(response: Response) {
  return {
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    status: response.status,
  };
}

describe("waitlist double opt-in submission", () => {
  test("publishes only the public site key and fixed actions", async () => {
    const { handler } = harness();
    const response = await handler(new Request("http://localhost/api/waitlist/config"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actions: { confirm: "waitlist_confirm", join: "waitlist_join" },
      siteKey: CONFIG.recaptchaSiteKey,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("new, pending, and confirmed addresses receive indistinguishable responses and provider work", async () => {
    const member = "member@example.com";
    const pending = "pending@example.com";
    const confirmed = "confirmed@example.com";
    const store = new MemoryWaitlistStore();
    await submitWaitlist(store, { clientId: "seed", email: pending }, new Date(NOW));
    await submitWaitlist(store, { clientId: "seed", email: confirmed }, new Date(NOW));
    await store.confirm(sha256(confirmed), "proof", NOW + 1);
    const { handler, sent } = harness({ store });

    const responses = await Promise.all([
      observed(await handler(join(member, "token-new"))),
      observed(await handler(join(pending, "token-pending"))),
      observed(await handler(join(confirmed, "token-confirmed"))),
    ]);
    expect(new Set(responses.map((response) => JSON.stringify(response))).size).toBe(1);
    expect(responses[0]).toEqual({
      body: '{"ok":true}',
      cacheControl: "no-store",
      contentType: "application/json;charset=utf-8",
      status: 202,
    });
    expect(sent.map((entry) => entry.email)).toEqual([member, pending, confirmed]);
    expect(sent.every((entry) => !entry.linkState.includes(entry.email))).toBe(true);
  });

  test("attestation is required before any store write or email", async () => {
    const store = new MemoryWaitlistStore();
    const { handler, sent } = harness({
      assess: async () => {
        throw new Error("low score");
      },
      store,
    });
    const response = await handler(join("member@example.com", "bad-token"));
    expect(response.status).toBe(403);
    expect(sent).toEqual([]);
    expect(store.peek(sha256("member@example.com"))).toBeUndefined();
    expect(await response.text()).not.toContain("score");
  });

  test("invalid attestations cannot drain the delivery budget", async () => {
    const calls: string[][] = [];
    const { handler } = harness({
      assess: async () => {
        throw new Error("invalid");
      },
      quota: {
        consume: async (rules) => {
          calls.push(rules.map((rule) => rule.key));
          return { allowed: true, retryAfterSeconds: 0 };
        },
      },
    });
    expect((await handler(join("member@example.com"))).status).toBe(403);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("waitlist:assessment-global");
    expect(calls[0]).not.toContain("waitlist:global");
  });

  test("provider failure fails closed without membership detail", async () => {
    const { handler } = harness({
      send: async () => {
        throw new Error("private provider detail");
      },
    });
    const response = await handler(join("member@example.com"));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("provider");
    expect(body).not.toContain("member@example.com");
  });
});

describe("explicit confirmation", () => {
  async function prepare(options: HarnessOptions = {}) {
    const store = options.store ?? new MemoryWaitlistStore();
    await submitWaitlist(store, { clientId: "seed", email: "member@example.com" }, new Date(NOW));
    const state = harness({ ...options, store });
    const linkState = await state.codec.sealLink("member@example.com", NOW);
    const response = await state.handler(
      new Request(
        `http://localhost/api/waitlist/confirm?state=${encodeURIComponent(linkState)}&oobCode=oob-code_1`,
      ),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    return { ...state, cookie: setCookie.split(";", 1)[0]!, getResponse: response };
  }

  function confirm(cookie: string, token = "recaptcha-confirm"): Request {
    return new Request("http://localhost/api/waitlist/confirm", {
      body: JSON.stringify({ recaptchaToken: token }),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: "http://localhost",
      },
      method: "POST",
    });
  }

  test("GET strips credentials without consuming or checking membership", async () => {
    const state = await prepare();
    expect(state.getResponse.status).toBe(303);
    expect(state.getResponse.headers.get("location")).toBe("/waitlist/confirm");
    expect(state.getResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.getResponse.headers.get("set-cookie")).toContain("HttpOnly");
    expect(state.getResponse.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(state.verified).toEqual([]);
    expect(state.assessed).toEqual([]);
    expect(state.quotaCalls).toEqual([]);
    expect(state.store.peek(sha256("member@example.com"))?.status).toBe("pending");
  });

  test("a user-initiated POST verifies bot, OOB purpose, and address before one CAS promotion", async () => {
    const state = await prepare();
    const response = await state.handler(confirm(state.cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "confirmed" });
    expect(state.assessed).toEqual([{ action: "waitlist_confirm", token: "recaptcha-confirm" }]);
    expect(state.verified).toEqual(["oob-code_1"]);
    expect(state.store.peek(sha256("member@example.com"))?.status).toBe("confirmed");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(state.quotaCalls).toHaveLength(2);
    expect(state.quotaCalls[0]).toContain("waitlist:assessment-global");
    expect(state.quotaCalls[0]).not.toContain("waitlist:confirm-global");
    expect(state.quotaCalls[1]).toContain("waitlist:confirm-global");
  });

  test("a forged browser proof cannot spend assessment or provider quota", async () => {
    const state = await prepare();
    const response = await state.handler(confirm(`${state.cookie.split("=", 1)[0]}=forged`));
    expect(response.status).toBe(400);
    expect(state.assessed).toEqual([]);
    expect(state.verified).toEqual([]);
    expect(state.quotaCalls).toEqual([]);
  });

  test("an invalid bot token cannot spend the provider verification budget", async () => {
    const state = await prepare({
      assess: async () => {
        throw new Error("invalid token");
      },
    });
    const response = await state.handler(confirm(state.cookie));
    expect(response.status).toBe(403);
    expect(state.verified).toEqual([]);
    expect(state.quotaCalls).toHaveLength(1);
    expect(state.quotaCalls[0]).toContain("waitlist:assessment-global");
    expect(state.quotaCalls[0]).not.toContain("waitlist:confirm-global");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a valid code for another address cannot promote the stored claim", async () => {
    const state = await prepare({ verify: async () => "somebody-else@example.com" });
    const response = await state.handler(confirm(state.cookie));
    expect(response.status).toBe(400);
    expect(state.store.peek(sha256("member@example.com"))?.status).toBe("pending");
    expect(await response.text()).toBe('{"error":"verification link is invalid or has expired"}');
  });

  test("cross-origin POSTs are refused before OOB verification", async () => {
    const state = await prepare();
    const request = confirm(state.cookie);
    request.headers.set("Origin", "https://attacker.example");
    const response = await state.handler(request);
    expect(response.status).toBe(403);
    expect(state.verified).toEqual([]);
    expect(state.quotaCalls).toEqual([]);
  });

  test("malformed GETs only redirect to a generic invalid page", async () => {
    const { handler } = harness();
    const response = await handler(
      new Request("http://localhost/api/waitlist/confirm?state=bad%20state&oobCode=bad%20code"),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/waitlist/confirm?result=invalid");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
