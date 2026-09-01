import { describe, expect, test } from "bun:test";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler, WAITLIST_TIMING_FLOOR_MS } from "../src/server.ts";
import { MemoryWaitlistQuota, type QuotaRule, type WaitlistQuota } from "../src/waitlist-quota.ts";
import { resolveWaitlistClient } from "../src/waitlist-client.ts";
import { MemoryWaitlistStore, type WaitlistStore } from "../src/waitlist.ts";

const config = getRuntimeConfig({
  ALLOWED_ORIGINS: "http://localhost:3000",
  DATA_DIR: "/tmp/medlock-enumeration-test",
  WAITLIST_BACKEND: "memory",
});

const post = (email: string, cookie?: string) =>
  new Request("http://localhost/api/waitlist", {
    body: JSON.stringify({ email }),
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    method: "POST",
  });

// Everything a caller can observe about one response.
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

describe("waitlist enumeration", () => {
  test("a known address and an unknown address are indistinguishable", async () => {
    const store = new MemoryWaitlistStore();
    const handler = createHandler({ config, sleep: async () => {}, waitlistStore: store });

    // Seed one address so the two calls below differ in exactly one way: one is
    // already stored, the other is not.
    await handler(post("known@example.com"));
    const known = await observe(await handler(post("known@example.com")));
    const unknown = await observe(await handler(post("unknown@example.com")));

    expect(known.status).toBe(202);
    expect(known.status).toBe(unknown.status);
    expect(known.body).toBe(unknown.body);
    expect(known.body).toBe('{"ok":true}');
    expect(known.headers).toEqual(unknown.headers);
    // The distinction still exists internally -- it just never ships.
    expect(store.size).toBe(2);
  });

  test("the response body never carries a membership field", async () => {
    const handler = createHandler({ config, sleep: async () => {}, waitlistStore: new MemoryWaitlistStore() });
    const first = await (await handler(post("shape@example.com"))).json() as Record<string, unknown>;
    const second = await (await handler(post("shape@example.com"))).json() as Record<string, unknown>;

    expect(Object.keys(first)).toEqual(["ok"]);
    expect(Object.keys(second)).toEqual(["ok"]);
    expect("duplicate" in first).toBe(false);
    expect("duplicate" in second).toBe(false);
  });

  test("both outcomes are held to the same timing floor", async () => {
    const slept: number[] = [];
    let clock = Date.parse("2026-09-01T12:00:00.000Z");
    const store = new MemoryWaitlistStore();
    const handler = createHandler({
      config,
      now: () => new Date(clock),
      // A duplicate is cheap and a create is not; advancing the clock only on
      // the create is the worst case this floor has to absorb.
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
      waitlistStore: {
        create: async (entry) => {
          const outcome = await store.create(entry);
          if (outcome === "created") clock += 120;
          return outcome;
        },
      } satisfies WaitlistStore,
    });

    await handler(post("timing@example.com"));
    const createdPad = slept.at(-1)!;
    await handler(post("timing@example.com"));
    const duplicatePad = slept.at(-1)!;

    expect(createdPad).toBe(WAITLIST_TIMING_FLOOR_MS - 120);
    expect(duplicatePad).toBe(WAITLIST_TIMING_FLOOR_MS);
    // Both land on the floor, so the observable time is identical.
    expect(createdPad + 120).toBe(duplicatePad);
  });

  test("a slow backend is never padded backwards", async () => {
    const slept: number[] = [];
    let clock = Date.parse("2026-09-01T12:00:00.000Z");
    const handler = createHandler({
      config,
      now: () => new Date(clock),
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
      waitlistStore: {
        create: async () => {
          clock += WAITLIST_TIMING_FLOOR_MS * 3;
          return "created";
        },
      } satisfies WaitlistStore,
    });

    await handler(post("slow@example.com"));
    expect(slept).toHaveLength(0);
  });
});

describe("waitlist quota enforcement at the boundary", () => {
  const failingQuota: WaitlistQuota = {
    consume: () => Promise.reject(new Error("private quota marker")),
  };

  test("a quota storage failure denies the request and leaks nothing", async () => {
    const store = new MemoryWaitlistStore();
    const response = await createHandler({
      config,
      sleep: async () => {},
      waitlistQuota: failingQuota,
      waitlistStore: store,
    })(post("closed@example.com"));
    const body = await response.text();

    // Fail closed: an instance that cannot advance the shared counter has no
    // idea how much budget is left, and guessing permissively is how a
    // distributed limit becomes no limit at all.
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(body).toBe('{"error":"waitlist temporarily unavailable"}');
    expect(body).not.toContain("private quota marker");
    // Nothing was written.
    expect(store.size).toBe(0);
  });

  test("the authoritative decision is the shared one, not the per-instance one", async () => {
    // Three handlers stand in for three Cloud Run instances. They share only
    // the Firestore-backed quota, exactly as deployed instances do. Each
    // request carries its own signed cookie so the per-client budget never
    // binds and the global budget is what is being measured.
    const secrets = [new Uint8Array(32).fill(11)];
    const shared = new MemoryWaitlistQuota();
    const instance = () =>
      createHandler({
        config,
        sleep: async () => {},
        waitlistIdentitySecrets: secrets,
        waitlistQuota: shared,
        waitlistStore: new MemoryWaitlistStore(),
      });
    const instances = [instance(), instance(), instance()];
    const cookies = Array.from({ length: 13 }, () => {
      const cookie = resolveWaitlistClient(new Request("https://medlock.ai/api/waitlist"), secrets)
        .setCookie?.split(";", 1)[0];
      if (!cookie) throw new Error("expected a signed test client cookie");
      return cookie;
    });

    const statuses: number[] = [];
    let index = 0;
    for (const cookie of cookies) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const handler = instances[index % instances.length]!;
        statuses.push((await handler(post(`spread-${index++}@example.com`, cookie))).status);
      }
    }

    // 60 per minute globally, across the whole fleet. Per-instance limiters
    // would have allowed 60 on each of the three.
    expect(statuses.filter((status) => status === 202)).toHaveLength(60);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  test("discarding the cookie moves a caller into the shared unestablished bucket", async () => {
    const shared = new MemoryWaitlistQuota();
    const handler = createHandler({
      config,
      sleep: async () => {},
      waitlistIdentitySecrets: [new Uint8Array(32).fill(12)],
      waitlistQuota: shared,
      waitlistStore: new MemoryWaitlistStore(),
    });

    const statuses: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      // No cookie is ever returned, so every request mints a fresh identity.
      statuses.push((await handler(post(`churn-${index}@example.com`))).status);
    }

    expect(statuses.slice(0, 5).every((status) => status === 202)).toBe(true);
    expect(statuses.slice(5).every((status) => status === 429)).toBe(true);
  });

  test("one address cannot be submitted repeatedly to generate mail", async () => {
    const shared = new MemoryWaitlistQuota();
    const secrets = [new Uint8Array(32).fill(13)];
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      // A fresh handler each time, so no per-client budget is involved: only
      // the per-address bucket can be what stops this.
      const handler = createHandler({
        config,
        sleep: async () => {},
        waitlistIdentitySecrets: secrets,
        waitlistQuota: shared,
        waitlistStore: new MemoryWaitlistStore(),
      });
      statuses.push((await handler(post("target@example.com"))).status);
    }

    expect(statuses).toEqual([202, 202, 202, 429, 429]);
  });

  test("the per-address bucket is keyed by hash, never by the address", async () => {
    const seen: QuotaRule[][] = [];
    const recording: WaitlistQuota = {
      consume: async (rules) => {
        seen.push([...rules]);
        return { allowed: true, retryAfterSeconds: 0 };
      },
    };
    await createHandler({
      config,
      sleep: async () => {},
      waitlistQuota: recording,
      waitlistStore: new MemoryWaitlistStore(),
    })(post("Secret.Person@Example.COM"));

    const keys = seen[0]!.map((rule) => rule.key);
    expect(keys.some((key) => key.startsWith("waitlist:email:"))).toBe(true);
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain("secret.person");
      expect(key).not.toContain("@");
    }
  });

  test("a spoofed forwarding header changes no quota key", async () => {
    const captured: string[][] = [];
    const recording: WaitlistQuota = {
      consume: async (rules) => {
        captured.push(rules.map((rule) => rule.key).toSorted());
        return { allowed: true, retryAfterSeconds: 0 };
      },
    };
    const handler = createHandler({
      config,
      sleep: async () => {},
      waitlistIdentitySecrets: [new Uint8Array(32).fill(14)],
      waitlistQuota: recording,
      waitlistStore: new MemoryWaitlistStore(),
    });
    const withHeader = (value: string) =>
      new Request("http://localhost/api/waitlist", {
        body: JSON.stringify({ email: "forward@example.com" }),
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": value,
          "X-Real-IP": value,
        },
        method: "POST",
      });

    await handler(withHeader("203.0.113.9"));
    await handler(withHeader("198.51.100.4, 203.0.113.9"));

    // Identical keys both times: the forwarding headers are inert, so there is
    // nothing for a caller to rotate.
    expect(captured[0]).toEqual(captured[1]!);
  });

  test("an unparseable body still spends the shared budget", async () => {
    let consumed = 0;
    const counting: WaitlistQuota = {
      consume: async () => {
        consumed += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      },
    };
    const handler = createHandler({
      config,
      sleep: async () => {},
      waitlistQuota: counting,
      waitlistStore: new MemoryWaitlistStore(),
    });
    const junk = await handler(
      new Request("http://localhost/api/waitlist", {
        body: "{not json",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
    const invalidEmail = await handler(post("not-an-email"));

    expect(junk.status).toBe(400);
    expect(invalidEmail.status).toBe(400);
    // A malformed body is charged; only a body that never reached the quota
    // would be free, and that is the case this asserts does not exist.
    expect(consumed).toBe(1);
  });
});
