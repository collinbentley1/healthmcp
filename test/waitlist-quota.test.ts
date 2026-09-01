import { describe, expect, test } from "bun:test";
import { FirestoreClient, type FetchLike } from "../src/firestore.ts";
import {
  FirestoreWaitlistQuota,
  MemoryWaitlistQuota,
  type QuotaRule,
} from "../src/waitlist-quota.ts";

// A commit fixture that behaves like Firestore: writes are applied atomically,
// an `increment` transform returns the value it produced, and a delete of a
// document that is not there is a no-op. Counters live outside the client, so
// several clients can share one -- which is the whole point, since the defect
// being fixed is that every Cloud Run instance kept its own.
function firestoreFleet() {
  const counters = new Map<string, number>();
  const commits: unknown[][] = [];
  const client = (fetcher?: FetchLike) =>
    new FirestoreClient({
      databaseId: "(default)",
      fetcher: fetcher ?? (async (input, init) => {
        const url = String(input);
        if (url.includes("metadata.google.internal")) {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        const body = JSON.parse(String(init?.body)) as { writes: Record<string, unknown>[] };
        commits.push(body.writes);
        const writeResults = body.writes.map((write) => {
          if (typeof write.delete === "string") {
            counters.delete(write.delete);
            return {};
          }
          const name = (write.update as { name: string }).name;
          const next = (counters.get(name) ?? 0) + 1;
          counters.set(name, next);
          return { transformResults: [{ integerValue: String(next) }] };
        });
        return Response.json({ writeResults });
      }),
      projectId: "medlock-1025243085",
    });
  return { client, commits, counters };
}

const quotaOf = (fleet: ReturnType<typeof firestoreFleet>, fetcher?: FetchLike) =>
  new FirestoreWaitlistQuota({ client: fleet.client(fetcher), collection: "waitlist_quota" });

const RULE: QuotaRule = { key: "waitlist:global", limit: 3, windowSeconds: 60 };
const AT = new Date("2026-09-01T12:00:30.000Z");

describe("waitlist quota", () => {
  test("the limit holds across independent instances, not per instance", async () => {
    // Four separate quota objects, exactly as four Cloud Run instances would
    // hold. Before this, each one would have allowed the full budget.
    const fleet = firestoreFleet();
    const instances = [quotaOf(fleet), quotaOf(fleet), quotaOf(fleet), quotaOf(fleet)];
    const decisions = [];
    for (let index = 0; index < 4; index += 1) {
      decisions.push(await instances[index]!.consume([RULE], AT));
    }

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
    expect(decisions[3]!.retryAfterSeconds).toBe(30);
  });

  test("concurrent requests to one bucket each get a distinct count", async () => {
    const fleet = firestoreFleet();
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => quotaOf(fleet).consume([RULE], AT)),
    );

    // Atomic increment means exactly `limit` winners, no matter the interleaving.
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(7);
  });

  test("a new window starts a new budget", async () => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet);
    for (let index = 0; index < 4; index += 1) await quota.consume([RULE], AT);
    const nextWindow = await quota.consume([RULE], new Date("2026-09-01T12:01:05.000Z"));

    expect(nextWindow.allowed).toBe(true);
  });

  test("every request retires the bucket two windows back", async () => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet);
    await quota.consume([RULE], new Date("2026-09-01T12:00:30.000Z"));
    expect(fleet.counters.size).toBe(1);
    await quota.consume([RULE], new Date("2026-09-01T12:01:30.000Z"));
    expect(fleet.counters.size).toBe(2);
    // The 12:00 bucket is now two windows back and is deleted by this request.
    await quota.consume([RULE], new Date("2026-09-01T12:02:30.000Z"));
    expect(fleet.counters.size).toBe(2);
    await quota.consume([RULE], new Date("2026-09-01T12:03:30.000Z"));
    expect(fleet.counters.size).toBe(2);
    // Cleanup is part of the same atomic commit as the increment.
    const lastCommit = fleet.commits.at(-1) as Record<string, unknown>[];
    expect(lastCommit.filter((write) => "delete" in write)).toHaveLength(1);
  });

  test("a storage failure denies rather than allows", async () => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet, async (input) =>
      String(input).includes("metadata.google.internal")
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : new Response("upstream exploded", { status: 503 }));

    await expect(quota.consume([RULE], AT)).rejects.toThrow("Firestore commit failed: 503");
  });

  test("a commit that answers for fewer writes than it was given is refused", async () => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet, async (input) =>
      String(input).includes("metadata.google.internal")
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : Response.json({ writeResults: [{ transformResults: [{ integerValue: "1" }] }] }));

    await expect(quota.consume([RULE], AT)).rejects.toThrow("incomplete result set");
  });

  test.each([
    ["absent", {}],
    ["non-numeric", { transformResults: [{ integerValue: "many" }] }],
    ["zero", { transformResults: [{ integerValue: "0" }] }],
  ])("a commit whose counter is %s is refused", async (_label, first) => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet, async (input) =>
      String(input).includes("metadata.google.internal")
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : Response.json({ writeResults: [first, {}] }));

    await expect(quota.consume([RULE], AT)).rejects.toThrow("unusable counter");
  });

  test("rules must be unique, bounded, and safely keyed", async () => {
    const quota = new MemoryWaitlistQuota();
    const bad: readonly QuotaRule[][] = [
      [],
      [RULE, RULE],
      [{ key: "waitlist:global", limit: 0, windowSeconds: 60 }],
      [{ key: "waitlist:global", limit: 3, windowSeconds: 0 }],
      [{ key: "", limit: 3, windowSeconds: 60 }],
      // A key that could reshape the document path.
      [{ key: "../../other", limit: 3, windowSeconds: 60 }],
      [{ key: "WAITLIST:GLOBAL", limit: 1.5, windowSeconds: 60 }],
    ];
    for (const rules of bad) {
      await expect(quota.consume(rules, AT)).rejects.toThrow();
    }
  });

  test("the document path never carries a raw key separator", async () => {
    const fleet = firestoreFleet();
    await quotaOf(fleet).consume([{ key: "waitlist:email:abc", limit: 1, windowSeconds: 60 }], AT);
    const name = ((fleet.commits[0] as Record<string, unknown>[])[0]!.update as { name: string }).name;

    expect(name).toContain("/documents/waitlist_quota/waitlist__email__abc--");
    expect(name.split("/documents/")[1]).not.toContain(":");
  });

  test("the in-memory stand-in matches the Firestore decision sequence", async () => {
    const memory = new MemoryWaitlistQuota();
    const decisions = [];
    for (let index = 0; index < 4; index += 1) decisions.push(await memory.consume([RULE], AT));

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
    await memory.consume([RULE], new Date("2026-09-01T12:02:30.000Z"));
    expect(memory.trackedBucketCount).toBeLessThanOrEqual(2);
  });
});
