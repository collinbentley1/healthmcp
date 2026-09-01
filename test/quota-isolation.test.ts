import { describe, expect, test } from "bun:test";
import { FirestoreClient } from "../src/firestore.ts";
import { FirestoreWaitlistQuota, type QuotaRule } from "../src/waitlist-quota.ts";

// These tests exist to answer one question: what does the quota guarantee if
// Firestore's cross-document isolation is NOT what we think it is?
//
// That question is not hypothetical. Isolation is a property of the service,
// invisible from outside, and the local emulator does not reproduce it
// faithfully -- a plain write racing a read-write transaction did not abort
// that transaction at all. So the fixture below deliberately provides NO
// isolation whatsoever: every commit succeeds, no read set is ever checked,
// and concurrent transactions freely interleave.
//
// The cap must still hold, because it is enforced from the value Firestore
// returns for the `increment` transform rather than from the value that was
// read beforehand.
function noIsolationFleet(options: { readonly barrier: number }) {
  const counters = new Map<string, number>();
  let transactions = 0;
  let arrived = 0;
  let release: () => void = () => {};
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  const client = new FirestoreClient({
    databaseId: "(default)",
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith(":beginTransaction")) {
        transactions += 1;
        return Response.json({ transaction: `txn-${transactions}` });
      }
      if (url.endsWith(":batchGet")) {
        const body = JSON.parse(String(init?.body)) as { documents: string[] };
        // Hold every caller here until they have all read the same state.
        // This is the worst case for a read-judge-write design: every instance
        // believes it saw the whole budget free.
        arrived += 1;
        if (arrived >= options.barrier) release();
        else await allArrived;
        return Response.json(body.documents.map((name) => {
          const current = counters.get(name);
          return current === undefined
            ? { missing: name }
            : { found: { fields: { count: { integerValue: String(current) } }, name } };
        }));
      }
      if (url.endsWith(":rollback")) return Response.json({});
      const body = JSON.parse(String(init?.body)) as {
        writes: Record<string, unknown>[];
      };
      // No read-set validation, no aborts, no serialization: isolation removed.
      const writeResults = body.writes.map((write) => {
        if (typeof write.delete === "string") return {};
        const name = (write.update as { name: string }).name;
        const transforms = (write.updateTransforms ?? []) as {
          increment?: { integerValue: string };
        }[];
        if (transforms.length === 0) return {};
        return {
          transformResults: transforms.map((transform) => {
            const next = (counters.get(name) ?? 0) +
              Number(transform.increment?.integerValue ?? "0");
            counters.set(name, next);
            return { integerValue: String(next) };
          }),
        };
      });
      return Response.json({ writeResults });
    },
    projectId: "medlock-1025243085",
  });
  return { client, counters };
}

describe("quota safety without isolation", () => {
  const RULES = (limit: number): QuotaRule[] => [
    { key: "global", limit, windowSeconds: 60 },
  ];

  test("admits at most the limit even when every request reads the same free budget", async () => {
    const RACERS = 12;
    const LIMIT = 4;
    const fleet = noIsolationFleet({ barrier: RACERS });
    const quota = new FirestoreWaitlistQuota({ client: fleet.client, collection: "q" });
    const now = new Date("2026-09-01T12:00:00.000Z");

    const decisions = await Promise.all(
      Array.from({ length: RACERS }, () => quota.consume(RULES(LIMIT), now)),
    );
    const allowed = decisions.filter((decision) => decision.allowed);

    // Every one of the twelve read "zero used, four available" and every one
    // committed. Without the post-increment check all twelve would have been
    // admitted against a limit of four.
    expect(allowed).toHaveLength(LIMIT);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(RACERS - LIMIT);
    // The counter still records every arrival, so the window stays exhausted.
    expect([...fleet.counters.values()][0]).toBe(RACERS);
  });

  test("a refusal forced by the backstop still reports a usable retry hint", async () => {
    const fleet = noIsolationFleet({ barrier: 3 });
    const quota = new FirestoreWaitlistQuota({ client: fleet.client, collection: "q" });
    const now = new Date("2026-09-01T12:00:30.000Z");
    const decisions = await Promise.all(
      Array.from({ length: 3 }, () => quota.consume(RULES(1), now)),
    );
    for (const decision of decisions.filter((entry) => !entry.allowed)) {
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });
});

// A commit whose effect cannot be read back is not evidence that the effect
// was within budget. The increment has already landed at that point, so there
// is no later opportunity to notice an overflow: it has to fail closed here.
describe("quota fails closed on an uncheckable commit", () => {
  function fleetReturning(writeResults: unknown) {
    return new FirestoreClient({
      databaseId: "(default)",
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.includes("metadata.google.internal")) {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "t" });
        if (url.endsWith(":batchGet")) {
          // Echo back exactly what was asked for; a fixture that guesses the
          // document name makes the test pass for the wrong reason.
          const body = JSON.parse(String(init?.body)) as { documents: string[] };
          return Response.json(body.documents.map((name) => ({ missing: name })));
        }
        if (url.endsWith(":rollback")) return Response.json({});
        return Response.json({ writeResults });
      },
      projectId: "medlock-1025243085",
    });
  }
  const RULES: QuotaRule[] = [{ key: "global", limit: 5, windowSeconds: 60 }];
  const NOW = new Date("2026-09-01T12:00:00.000Z");

  const cases: readonly (readonly [string, unknown])[] = [
    ["transform results omitted", [{}]],
    ["no write results at all", []],
    ["transform result is not an array", [{ transformResults: { integerValue: "1" } }]],
    ["transform result carries the wrong arity", [{ transformResults: [] }]],
    ["counter came back as a string", [{ transformResults: [{ stringValue: "1" }] }]],
    ["counter is not a safe integer", [{ transformResults: [{ integerValue: "9007199254740993" }] }]],
    ["counter is negative", [{ transformResults: [{ integerValue: "-1" }] }]],
    ["counter is zero, which no increment can produce", [{ transformResults: [{ integerValue: "0" }] }]],
  ];
  for (const [name, writeResults] of cases) {
    test(name, async () => {
      const quota = new FirestoreWaitlistQuota({
        client: fleetReturning(writeResults),
        collection: "q",
      });
      expect(quota.consume(RULES, NOW)).rejects.toThrow();
    });
  }
});

// An ABORTED is a lock timeout, so retrying is not free. Without a wall-clock
// bound, contention would decide how long a request takes -- which is both a
// latency amplifier and a signal about somebody else's traffic.
describe("quota bounds its own retry latency", () => {
  test("stops retrying once the decision deadline passes", async () => {
    let commits = 0;
    const client = new FirestoreClient({
      databaseId: "(default)",
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.includes("metadata.google.internal")) {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "t" });
        if (url.endsWith(":batchGet")) {
          // Echo back exactly what was asked for; a fixture that guesses the
          // document name makes the test pass for the wrong reason.
          const body = JSON.parse(String(init?.body)) as { documents: string[] };
          return Response.json(body.documents.map((name) => ({ missing: name })));
        }
        if (url.endsWith(":rollback")) return Response.json({});
        commits += 1;
        return Response.json(
          { error: { code: 409, message: "Transaction lock timeout.", status: "ABORTED" } },
          { status: 409 },
        );
      },
      projectId: "medlock-1025243085",
    });
    // A clock that advances past the budget after the first attempt.
    let ticks = 0;
    const quota = new FirestoreWaitlistQuota({
      client,
      collection: "q",
      deadlineMs: 1_000,
      monotonicNow: () => {
        ticks += 1;
        return ticks === 1 ? 0 : 5_000;
      },
    });
    expect(
      quota.consume([{ key: "global", limit: 5, windowSeconds: 60 }], new Date("2026-09-01T12:00:00.000Z")),
    ).rejects.toThrow(/deadline/);
    await Bun.sleep(1);
    // One attempt, not five: the deadline cut the retry loop short.
    expect(commits).toBe(1);
  });
});
