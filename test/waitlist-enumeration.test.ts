import { describe, expect, test } from "bun:test";
import { getRuntimeConfig } from "../src/config.ts";
import {
  createHandler,
  WAITLIST_TIMING_FLOOR_MS,
  WAITLIST_TIMING_JITTER_MS,
} from "../src/server.ts";
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

  // The exact invariant, stated rather than implied.
  //
  // This is a FLOOR, not constant time. It guarantees: no accepted submission
  // returns before WAITLIST_TIMING_FLOOR_MS of monotonic time have passed, and
  // the pad is extended by an unpredictable draw the caller cannot subtract
  // back out. It does NOT guarantee that a backend slower than the floor is
  // hidden -- if the create path ever exceeded the floor, the excess would be
  // observable, and that limit is asserted below rather than papered over.
  const paddedRun = async (options: {
    readonly backendMs: number;
    readonly duplicate: boolean;
  }) => {
    const store = new MemoryWaitlistStore();
    if (options.duplicate) {
      await store.create({
        clientHash: "seed",
        confirmedAt: null,
        confirmedSubject: null,
        createdAt: "2026-09-01T12:00:00.000Z",
        email: "timing@example.com",
        emailHash: new Bun.CryptoHasher("sha256").update("timing@example.com").digest("hex"),
        expiresAt: "2026-10-01T12:00:00.000Z",
        source: "test",
        status: "pending",
        userAgentHash: "seed",
      });
    }
    let monotonic = 1_000;
    const slept: number[] = [];
    const handler = createHandler({
      config,
      monotonicNow: () => monotonic,
      sleep: async (ms: number) => {
        slept.push(ms);
        monotonic += ms;
      },
      waitlistStore: {
        confirm: async (...args) => await store.confirm(...args),
        pendingExists: async (...args) => await store.pendingExists(...args),
        create: async (entry) => {
          const outcome = await store.create(entry);
          // Only the create path does real work.
          if (outcome === "created") monotonic += options.backendMs;
          return outcome;
        },
      } satisfies WaitlistStore,
    });
    const started = monotonic;
    await handler(post("timing@example.com"));
    return { elapsed: monotonic - started, slept };
  };

  test("no accepted submission returns before the floor, whichever outcome it was", async () => {
    const created = await paddedRun({ backendMs: 120, duplicate: false });
    const duplicate = await paddedRun({ backendMs: 120, duplicate: true });

    expect(created.elapsed).toBeGreaterThanOrEqual(WAITLIST_TIMING_FLOOR_MS);
    expect(duplicate.elapsed).toBeGreaterThanOrEqual(WAITLIST_TIMING_FLOOR_MS);
    // Both were padded; neither returned early because its work was cheap.
    expect(created.slept).toHaveLength(1);
    expect(duplicate.slept).toHaveLength(1);
  });

  test("the pad is unpredictable and bounded", async () => {
    const draws = new Set<number>();
    for (let index = 0; index < 12; index += 1) {
      const run = await paddedRun({ backendMs: 0, duplicate: true });
      expect(run.elapsed).toBeGreaterThanOrEqual(WAITLIST_TIMING_FLOOR_MS);
      expect(run.elapsed).toBeLessThan(WAITLIST_TIMING_FLOOR_MS + WAITLIST_TIMING_JITTER_MS);
      draws.add(run.elapsed);
    }
    // A fixed floor would give one value every time; the jitter is what stops a
    // single observation from being a clean read of the work underneath it.
    expect(draws.size).toBeGreaterThan(1);
  });

  test("the floor does not truncate work slower than itself, and that is the limit", async () => {
    // Stated honestly: a backend slower than the floor IS observable. The floor
    // equalises the paths only while both finish under it, which is why the
    // create path must not carry work the duplicate path does not -- no
    // synchronous mail dispatch on the new-address side, for instance.
    const slow = await paddedRun({
      backendMs: WAITLIST_TIMING_FLOOR_MS + WAITLIST_TIMING_JITTER_MS + 500,
      duplicate: false,
    });

    expect(slow.slept).toHaveLength(0);
    expect(slow.elapsed).toBeGreaterThan(WAITLIST_TIMING_FLOOR_MS + WAITLIST_TIMING_JITTER_MS);
  });

  test("a wall-clock jump cannot remove the pad", async () => {
    // The pad is measured monotonically, so a clock that leaps forward mid
    // request -- an NTP correction, say -- neither cancels it nor stalls on it.
    let monotonic = 5_000;
    const slept: number[] = [];
    let wall = Date.parse("2026-09-01T12:00:00.000Z");
    const handler = createHandler({
      config,
      monotonicNow: () => monotonic,
      now: () => {
        wall += 86_400_000;
        return new Date(wall);
      },
      sleep: async (ms: number) => {
        slept.push(ms);
        monotonic += ms;
      },
      waitlistStore: new MemoryWaitlistStore(),
    });

    await handler(post("clockjump@example.com"));
    expect(slept).toHaveLength(1);
    expect(slept[0]!).toBeGreaterThan(0);
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

describe("waitlist activation", () => {
  const activationPost = (idToken: unknown) =>
    new Request("http://localhost/api/waitlist/activate", {
      body: JSON.stringify({ idToken }),
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      method: "POST",
    });
  const configured = getRuntimeConfig({
    ALLOWED_ORIGINS: "http://localhost:3000",
    DATA_DIR: "/tmp/medlock-activation-test",
    IDENTITY_PLATFORM_AUDIENCE: "medlock-1025243085",
    WAITLIST_BACKEND: "memory",
  });
  const seeded = async () => {
    const store = new MemoryWaitlistStore();
    await createHandler({ config, sleep: async () => {}, waitlistStore: store })(
      post("member@example.com"),
    );
    return store;
  };

  test("activation refuses outright when the flow is not provisioned", async () => {
    // No audience configured means no token can be trusted. Refusing is the
    // only honest answer; activating would be trusting an unnamed issuer.
    const response = await createHandler({ config, waitlistStore: new MemoryWaitlistStore() })(
      activationPost("anything"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "waitlist activation is not available" });
  });

  test("a verified token promotes exactly one pending entry", async () => {
    const store = await seeded();
    const response = await createHandler({
      config: configured,
      identityVerifier: {
        verify: async () => ({
          email: "member@example.com",
          expiresAtMs: 0,
          issuedAtMs: 0,
          subject: "subject-1",
        }),
      },
      waitlistStore: store,
    })(activationPost("token"));

    expect(response.status).toBe(200);
    const hash = new Bun.CryptoHasher("sha256").update("member@example.com").digest("hex");
    expect(store.peek(hash)!.status).toBe("confirmed");
  });

  test("a replayed token is indistinguishable from a first activation", async () => {
    const store = await seeded();
    const handler = createHandler({
      config: configured,
      identityVerifier: {
        verify: async () => ({
          email: "member@example.com",
          expiresAtMs: 0,
          issuedAtMs: 0,
          subject: "subject-1",
        }),
      },
      waitlistStore: store,
    });
    const first = await handler(activationPost("token"));
    const replay = await handler(activationPost("token"));

    expect(replay.status).toBe(first.status);
    expect(await replay.text()).toBe(await first.text());
  });

  test("an unverifiable token and an unknown address answer identically", async () => {
    const store = await seeded();
    const refuse = await createHandler({
      config: configured,
      identityVerifier: {
        verify: async () => {
          throw new Error("signature did not verify");
        },
      },
      waitlistStore: store,
    })(activationPost("token"));
    const unknown = await createHandler({
      config: configured,
      identityVerifier: {
        verify: async () => ({
          email: "stranger@example.com",
          expiresAtMs: 0,
          issuedAtMs: 0,
          subject: "subject-2",
        }),
      },
      waitlistStore: store,
    })(activationPost("token"));

    // Whether an address was ever submitted is a membership fact, so a bad
    // token and an unknown address must not be told apart.
    expect(refuse.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await refuse.text()).toBe(await unknown.text());
  });

  test("activation spends the shared budget", async () => {
    const store = await seeded();
    let consumed = 0;
    const handler = createHandler({
      config: configured,
      identityVerifier: {
        verify: async () => {
          throw new Error("nope");
        },
      },
      waitlistQuota: {
        consume: async () => {
          consumed += 1;
          return { allowed: true, retryAfterSeconds: 0 };
        },
      },
      waitlistStore: store,
    });
    await handler(activationPost("token"));

    // Otherwise activation would be an unmetered oracle for guessing tokens.
    expect(consumed).toBe(1);
  });
});
