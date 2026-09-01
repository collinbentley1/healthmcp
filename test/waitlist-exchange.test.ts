import { describe, expect, test } from "bun:test";
import { getRuntimeConfig } from "../src/config.ts";
import { IdentityPlatformClient } from "../src/identity-platform.ts";
import { createHandler } from "../src/server.ts";
import { MemoryWaitlistStore, sha256, submitWaitlist } from "../src/waitlist.ts";

const MEMBER = "member@example.com";
const HASH = sha256(MEMBER);
const NOW = new Date("2026-09-01T12:00:00.000Z");

const ENABLED = getRuntimeConfig({
  ALLOWED_ORIGINS: "http://localhost:3000",
  DATA_DIR: "/tmp/medlock-exchange-test",
  IDENTITY_PLATFORM_AUDIENCE: "medlock-1025243085",
  IDENTITY_PLATFORM_CONTINUE_URL: "https://medlock.ai/api/waitlist/confirm",
  WAITLIST_ACTIVATION_ENABLED: "true",
  WAITLIST_BACKEND: "memory",
});
const NOT_ENABLED = getRuntimeConfig({
  ALLOWED_ORIGINS: "http://localhost:3000",
  DATA_DIR: "/tmp/medlock-exchange-test",
  IDENTITY_PLATFORM_AUDIENCE: "medlock-1025243085",
  IDENTITY_PLATFORM_CONTINUE_URL: "https://medlock.ai/api/waitlist/confirm",
  WAITLIST_BACKEND: "memory",
});

const confirmUrl = (params: Record<string, string>) =>
  new Request(
    `http://localhost/api/waitlist/confirm?${new URLSearchParams(params).toString()}`,
    { headers: { Origin: "http://localhost:3000" }, method: "GET" },
  );

async function observe(response: Response) {
  return {
    body: await response.text(),
    headers: [...response.headers.entries()]
      .filter(([name]) => name.toLowerCase() !== "set-cookie")
      .map(([name, value]) => `${name}: ${value}`)
      .toSorted(),
    status: response.status,
  };
}

async function seeded() {
  const store = new MemoryWaitlistStore();
  await submitWaitlist(store, { clientId: "c".repeat(43), email: MEMBER, source: "site" }, NOW);
  return store;
}

// A dispatcher whose exchange succeeds, and a verifier that returns whatever
// identity the test wants to model.
function wiring(options: {
  readonly exchange?: (email: string, oobCode: string) => Promise<string>;
  readonly identityEmail?: string;
} = {}) {
  const exchanged: { email: string; oobCode: string }[] = [];
  return {
    exchanged,
    identityDispatcher: {
      exchangeSignInLink: async (email: string, oobCode: string) => {
        exchanged.push({ email, oobCode });
        if (options.exchange) return await options.exchange(email, oobCode);
        return "id.token.value";
      },
      sendSignInLink: async () => {},
    },
    identityVerifier: {
      verify: async () => ({
        email: options.identityEmail ?? MEMBER,
        expiresAtMs: NOW.getTime() + 3_600_000,
        issuedAtMs: NOW.getTime(),
        subject: "identity-subject-1",
      }),
    },
  };
}

describe("exchange promotes only a proved address", () => {
  test("a valid link confirms the entry", async () => {
    const store = await seeded();
    const wired = wiring();
    const handler = createHandler({
      config: ENABLED,
      now: () => NOW,
      sleep: async () => {},
      waitlistStore: store,
      ...wired,
    });
    const response = await handler(confirmUrl({ h: HASH, oobCode: "valid-oob-code" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "confirmed" });
    expect(store.peek(HASH)?.status).toBe("confirmed");
    // The address recovered from the hash is what was presented to Identity
    // Platform, alongside the code from the link.
    expect(wired.exchanged).toEqual([{ email: MEMBER, oobCode: "valid-oob-code" }]);
  });

  test("replaying the same link does not promote twice", async () => {
    const store = await seeded();
    const handler = createHandler({
      config: ENABLED,
      now: () => NOW,
      sleep: async () => {},
      waitlistStore: store,
      ...wiring(),
    });
    const first = await handler(confirmUrl({ h: HASH, oobCode: "valid-oob-code" }));
    const second = await handler(confirmUrl({ h: HASH, oobCode: "valid-oob-code" }));
    expect(first.status).toBe(200);
    // The second attempt cannot find a live pending entry any more, so it is
    // refused -- and refused identically to every other failure.
    expect(second.status).toBe(400);
    expect(store.peek(HASH)?.confirmedSubject).toBe("identity-subject-1");
  });

  // The substitution attack: a real oobCode for one address, aimed at another
  // address's entry.
  test("a token for a different address cannot promote this entry", async () => {
    const store = await seeded();
    const handler = createHandler({
      config: ENABLED,
      now: () => NOW,
      sleep: async () => {},
      waitlistStore: store,
      ...wiring({ identityEmail: "attacker@example.com" }),
    });
    const response = await handler(confirmUrl({ h: HASH, oobCode: "valid-oob-code" }));
    expect(response.status).toBe(400);
    expect(store.peek(HASH)?.status).toBe("pending");
  });

  test("an exchange that fails promotes nothing", async () => {
    const store = await seeded();
    const handler = createHandler({
      config: ENABLED,
      now: () => NOW,
      sleep: async () => {},
      waitlistStore: store,
      ...wiring({
        exchange: async () => {
          throw new Error("Identity Platform signInWithEmailLink failed: 400");
        },
      }),
    });
    expect((await handler(confirmUrl({ h: HASH, oobCode: "stale-code" }))).status).toBe(400);
    expect(store.peek(HASH)?.status).toBe("pending");
  });
});

describe("exchange answers no membership question", () => {
  test("every failure is byte-identical", async () => {
    // A fresh handler per variant. Sharing one would let the global quota fire
    // partway through and produce a 429, which would compare unequal for a
    // reason that has nothing to do with what is being tested here.
    const build = async () =>
      createHandler({
        config: ENABLED,
        now: () => NOW,
        sleep: async () => {},
        waitlistStore: await seeded(),
        ...wiring({
          exchange: async () => {
            throw new Error("rejected");
          },
        }),
      });
    const variants = [
      // A real member with a bad code.
      { h: HASH, oobCode: "wrong-code" },
      // A hash an attacker computed for an address they are curious about.
      { h: sha256("victim@example.com"), oobCode: "wrong-code" },
      // Structurally invalid parameters.
      { h: "not-a-hash", oobCode: "wrong-code" },
      { h: HASH, oobCode: "" },
      { h: HASH, oobCode: "has spaces and/slashes" },
      { h: HASH, oobCode: "x".repeat(4096) },
      { h: "", oobCode: "" },
    ];
    const seen = new Set<string>();
    for (const params of variants) {
      const handler = await build();
      seen.add(JSON.stringify(await observe(await handler(confirmUrl(params)))));
    }
    expect(seen.size).toBe(1);
  });

  test("the code and the address never appear in the response", async () => {
    const store = await seeded();
    const handler = createHandler({
      config: ENABLED,
      now: () => NOW,
      sleep: async () => {},
      waitlistStore: store,
      ...wiring({
        exchange: async () => {
          throw new Error("rejected");
        },
      }),
    });
    const body = await (await handler(confirmUrl({ h: HASH, oobCode: "secret-oob" }))).text();
    expect(body).not.toContain("secret-oob");
    expect(body).not.toContain(MEMBER);
    expect(body).not.toContain(HASH);
  });

  test("a provisioned but not-yet-enabled deployment refuses everything", async () => {
    const store = await seeded();
    const handler = createHandler({
      config: NOT_ENABLED,
      sleep: async () => {},
      waitlistStore: store,
      ...wiring(),
    });
    const response = await handler(confirmUrl({ h: HASH, oobCode: "valid-oob-code" }));
    expect(response.status).toBe(503);
    expect(store.peek(HASH)?.status).toBe("pending");
  });

  test("nothing is exchanged when the quota refuses", async () => {
    const store = await seeded();
    const wired = wiring();
    const handler = createHandler({
      config: ENABLED,
      sleep: async () => {},
      waitlistQuota: { consume: async () => ({ allowed: false, retryAfterSeconds: 30 }) },
      waitlistStore: store,
      ...wired,
    });
    expect((await handler(confirmUrl({ h: HASH, oobCode: "valid" }))).status).toBe(429);
    expect(wired.exchanged).toEqual([]);
  });
});

// The exchange call itself: what it sends, and what it refuses to accept back.
describe("keyless exchange transport", () => {
  function clientWith(responder: (url: string, init?: RequestInit) => Response) {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const client = new IdentityPlatformClient({
      continueUrl: "https://medlock.ai/api/waitlist/confirm",
      fetcher: async (url, init) => {
        if (String(url).includes("metadata.google.internal")) {
          return Response.json({ access_token: "sa-token", expires_in: 3600 });
        }
        seen.push({ init, url: String(url) });
        return responder(String(url), init);
      },
      projectId: "medlock-1025243085",
    });
    return { client, seen };
  }
  const ok = () => Response.json({ email: MEMBER, idToken: "issued.id.token", localId: "u1" });

  test("carries a bearer token and no API key anywhere", async () => {
    const { client, seen } = clientWith(ok);
    expect(await client.exchangeSignInLink(MEMBER, "code", NOW.getTime())).toBe("issued.id.token");
    const call = seen.at(-1)!;
    expect(call.url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink");
    // The whole point of the design: no key in the URL, an OAuth bearer instead.
    expect(call.url).not.toContain("key=");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sa-token");
    expect(JSON.stringify(call.init?.body)).not.toContain("apiKey");
  });

  test("a second-factor challenge is not treated as a partial success", async () => {
    const { client } = clientWith(() =>
      Response.json({ email: MEMBER, mfaInfo: [], mfaPendingCredential: "pending" })
    );
    await expect(client.exchangeSignInLink(MEMBER, "code", NOW.getTime()))
      .rejects.toThrow(/second factor/);
  });

  test("a response with no ID token proves nothing", async () => {
    for (const body of [{ email: MEMBER }, { email: MEMBER, idToken: "" }, { idToken: 42 }]) {
      const { client } = clientWith(() => Response.json(body));
      await expect(client.exchangeSignInLink(MEMBER, "code", NOW.getTime())).rejects.toThrow();
    }
  });

  test("a response naming a different address is refused", async () => {
    const { client } = clientWith(() =>
      Response.json({ email: "someone.else@example.com", idToken: "issued" })
    );
    await expect(client.exchangeSignInLink(MEMBER, "code", NOW.getTime()))
      .rejects.toThrow(/different address/);
  });

  test("a failure carries the status and nothing sensitive", async () => {
    const { client } = clientWith(() => new Response("nope", { status: 403 }));
    await expect(client.exchangeSignInLink(MEMBER, "secret-code", NOW.getTime()))
      .rejects.toThrow(/failed: 403/);
    await client.exchangeSignInLink(MEMBER, "secret-code", NOW.getTime()).catch((error: Error) => {
      expect(error.message).not.toContain("secret-code");
      expect(error.message).not.toContain(MEMBER);
    });
  });

  test("an unreadable body is refused rather than coerced", async () => {
    for (const body of ["not json", "[]", "null", '"idToken"']) {
      const { client } = clientWith(() => new Response(body, { status: 200 }));
      await expect(client.exchangeSignInLink(MEMBER, "code", NOW.getTime())).rejects.toThrow();
    }
  });

  test("the mailed link carries the entry hash so the exchange can find the address", async () => {
    const { client, seen } = clientWith(() => Response.json({}));
    await client.sendSignInLink(MEMBER, HASH, NOW.getTime());
    const body = JSON.parse(String(seen.at(-1)!.init!.body)) as { continueUrl: string };
    expect(new URL(body.continueUrl).searchParams.get("h")).toBe(HASH);
    // The address itself is not put in the return link.
    expect(body.continueUrl).not.toContain(MEMBER);
  });
});
