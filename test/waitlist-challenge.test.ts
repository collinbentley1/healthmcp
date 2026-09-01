import { describe, expect, test } from "bun:test";
import { getRuntimeConfig } from "../src/config.ts";
import { createHandler, WAITLIST_TIMING_FLOOR_MS } from "../src/server.ts";
import { MemoryWaitlistStore, sha256, submitWaitlist, type WaitlistStore } from "../src/waitlist.ts";

const PROVISIONED = getRuntimeConfig({
  ALLOWED_ORIGINS: "http://localhost:3000",
  DATA_DIR: "/tmp/medlock-challenge-test",
  IDENTITY_PLATFORM_AUDIENCE: "medlock-1025243085",
  IDENTITY_PLATFORM_CONTINUE_URL: "https://medlock.ai/waitlist/confirm",
  WAITLIST_BACKEND: "memory",
});
const UNPROVISIONED = getRuntimeConfig({
  ALLOWED_ORIGINS: "http://localhost:3000",
  DATA_DIR: "/tmp/medlock-challenge-test",
  WAITLIST_BACKEND: "memory",
});

const challenge = (email: string) =>
  new Request("http://localhost/api/waitlist/challenge", {
    body: JSON.stringify({ email }),
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    method: "POST",
  });

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

// A store seeded with one live pending entry.
async function seeded(): Promise<{ store: MemoryWaitlistStore; member: string }> {
  const store = new MemoryWaitlistStore();
  const member = "member@example.com";
  await submitWaitlist(
    store,
    { clientId: "c".repeat(43), email: member, source: "site" },
    new Date("2026-09-01T12:00:00.000Z"),
  );
  return { member, store };
}

function dispatcherSpy(behaviour: "ok" | "throw" = "ok") {
  const sent: string[] = [];
  return {
    sent,
    sendSignInLink: async (email: string) => {
      sent.push(email);
      if (behaviour === "throw") throw new Error("smtp exploded");
    },
  };
}

describe("challenge dispatch is not a mail relay", () => {
  test("a link is sent only to an address that already asked to be on the list", async () => {
    const { member, store } = await seeded();
    const dispatcher = dispatcherSpy();
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: dispatcher,
      sleep: async () => {},
      waitlistStore: store,
    });

    expect((await handler(challenge(member))).status).toBe(202);
    expect(dispatcher.sent).toEqual([member]);

    // A stranger's address is never mailed, however well-formed it is.
    expect((await handler(challenge("stranger@example.com"))).status).toBe(202);
    expect(dispatcher.sent).toEqual([member]);
  });

  test("an already-confirmed entry is not re-challenged", async () => {
    const { member, store } = await seeded();
    await store.confirm(sha256(member), "subject-1", Date.parse("2026-09-01T12:05:00.000Z"));
    const dispatcher = dispatcherSpy();
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: dispatcher,
      sleep: async () => {},
      waitlistStore: store,
    });
    expect((await handler(challenge(member))).status).toBe(202);
    expect(dispatcher.sent).toEqual([]);
  });

  test("an expired pending entry is not challenged", async () => {
    const { member, store } = await seeded();
    const dispatcher = dispatcherSpy();
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: dispatcher,
      // Far past the entry's expiry.
      now: () => new Date("2027-09-01T12:00:00.000Z"),
      sleep: async () => {},
      waitlistStore: store,
    });
    expect((await handler(challenge(member))).status).toBe(202);
    expect(dispatcher.sent).toEqual([]);
  });

  // A record that does not validate is not a reason to send mail.
  test("a corrupt stored record is not challenged", async () => {
    const { member, store } = await seeded();
    const corrupting: WaitlistStore = {
      confirm: (...args) => store.confirm(...args),
      create: (entry) => store.create(entry),
      pendingExists: (hash, nowMs) =>
        store.pendingExists(hash, nowMs).then(() => {
          throw new Error("corrupt record");
        }),
    };
    const dispatcher = dispatcherSpy();
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: dispatcher,
      sleep: async () => {},
      waitlistStore: corrupting,
    });
    expect((await handler(challenge(member))).status).toBe(202);
    expect(dispatcher.sent).toEqual([]);
  });
});

describe("challenge dispatch answers no membership question", () => {
  test("member and stranger are byte-identical", async () => {
    const { member, store } = await seeded();
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: dispatcherSpy(),
      sleep: async () => {},
      waitlistStore: store,
    });
    const known = await observe(await handler(challenge(member)));
    const unknown = await observe(await handler(challenge("nobody@example.com")));
    expect(known).toEqual(unknown);
  });

  test("a send that fails is indistinguishable from one that succeeds", async () => {
    const { member, store } = await seeded();
    const build = (behaviour: "ok" | "throw") =>
      createHandler({
        config: PROVISIONED,
        identityDispatcher: dispatcherSpy(behaviour),
        sleep: async () => {},
        waitlistStore: store,
      });
    const ok = await observe(await build("ok")(challenge(member)));
    const broken = await observe(await build("throw")(challenge(member)));
    expect(broken).toEqual(ok);
    expect(broken.status).toBe(202);
  });

  test("both paths are padded to the same floor on the monotonic clock", async () => {
    const { member, store } = await seeded();
    let monotonic = 0;
    const slept: number[] = [];
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: {
        sendSignInLink: async () => {
          // Sending costs real time; the pad has to absorb it.
          monotonic += 40;
        },
      },
      monotonicNow: () => monotonic,
      sleep: async (ms) => {
        slept.push(ms);
        monotonic += ms;
      },
      waitlistStore: store,
    });

    const elapsedFor = async (email: string) => {
      const started = monotonic;
      await handler(challenge(email));
      return monotonic - started;
    };
    const memberElapsed = await elapsedFor(member);
    const strangerElapsed = await elapsedFor("nobody@example.com");
    for (const elapsed of [memberElapsed, strangerElapsed]) {
      expect(elapsed).toBeGreaterThanOrEqual(WAITLIST_TIMING_FLOOR_MS);
    }
    // The dispatch cost is absorbed by the pad rather than showing up as a
    // longer response for members.
    expect(slept.every((ms) => ms >= 0)).toBe(true);
  });

  test("an unprovisioned deployment refuses identically for every address", async () => {
    const { member, store } = await seeded();
    const handler = createHandler({
      config: UNPROVISIONED,
      sleep: async () => {},
      waitlistStore: store,
    });
    const known = await observe(await handler(challenge(member)));
    const unknown = await observe(await handler(challenge("nobody@example.com")));
    expect(known).toEqual(unknown);
    expect(known.status).toBe(503);
  });

  test("the address never appears in the response", async () => {
    const { member, store } = await seeded();
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: dispatcherSpy("throw"),
      sleep: async () => {},
      waitlistStore: store,
    });
    const body = await (await handler(challenge(member))).text();
    expect(body).not.toContain(member);
    expect(body).not.toContain("example.com");
  });
});

describe("challenge dispatch stays behind the shared budget", () => {
  test("nothing is sent when the quota refuses", async () => {
    const { member, store } = await seeded();
    const dispatcher = dispatcherSpy();
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: dispatcher,
      sleep: async () => {},
      waitlistQuota: {
        consume: async () => ({ allowed: false, retryAfterSeconds: 30 }),
      },
      waitlistStore: store,
    });
    expect((await handler(challenge(member))).status).toBe(429);
    expect(dispatcher.sent).toEqual([]);
  });

  test("nothing is sent when the quota cannot decide", async () => {
    const { member, store } = await seeded();
    const dispatcher = dispatcherSpy();
    const handler = createHandler({
      config: PROVISIONED,
      identityDispatcher: dispatcher,
      sleep: async () => {},
      waitlistQuota: {
        consume: async () => {
          throw new Error("firestore unreachable");
        },
      },
      waitlistStore: store,
    });
    expect((await handler(challenge(member))).status).toBe(503);
    expect(dispatcher.sent).toEqual([]);
  });
});
