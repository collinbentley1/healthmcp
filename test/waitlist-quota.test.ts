import { describe, expect, test } from "bun:test";
import { FirestoreClient, type FetchLike } from "../src/firestore.ts";
import {
  FirestoreWaitlistQuota,
  MemoryWaitlistQuota,
  type QuotaRule,
} from "../src/waitlist-quota.ts";

// A Firestore fixture that speaks the transaction protocol, because that is
// what the quota now uses: begin, read inside the transaction, judge, and only
// then commit. Counters live outside the client so several clients can share
// one -- which is the point, since the defect being fixed is that every Cloud
// Run instance kept its own.
//
// `abortNext` models contention: Firestore aborts a commit whose read set moved
// underneath it, and the caller must retry rather than assume its decision
// still holds.
function firestoreFleet() {
  const counters = new Map<string, number>();
  const versions = new Map<string, number>();
  const readSets = new Map<string, Map<string, number>>();
  const commits: unknown[][] = [];
  const rollbacks: string[] = [];
  let transactions = 0;
  let abortNext = 0;
  const versionOf = (name: string) => versions.get(name) ?? 0;
  const client = (fetcher?: FetchLike) =>
    new FirestoreClient({
      databaseId: "(default)",
      fetcher: fetcher ?? (async (input, init) => {
        const url = String(input);
        if (url.includes("metadata.google.internal")) {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        if (url.endsWith(":beginTransaction")) {
          transactions += 1;
          return Response.json({ transaction: `txn-${transactions}` });
        }
        if (url.endsWith(":batchGet")) {
          const body = JSON.parse(String(init?.body)) as {
            documents: string[];
            transaction: string;
          };
          // Record the read set and the version each document had when read,
          // so the commit below can detect that something moved underneath it.
          readSets.set(
            body.transaction,
            new Map(body.documents.map((name) => [name, versionOf(name)])),
          );
          return Response.json(body.documents.map((name) => {
            const current = counters.get(name);
            return current === undefined
              ? { missing: name }
              : { found: { fields: { count: { integerValue: String(current) } }, name } };
          }));
        }
        if (url.endsWith(":rollback")) {
          rollbacks.push(JSON.parse(String(init?.body)).transaction as string);
          return Response.json({});
        }
        const body = JSON.parse(String(init?.body)) as {
          transaction?: string;
          writes: Record<string, unknown>[];
        };
        if (abortNext > 0) {
          abortNext -= 1;
          // What Firestore actually sends for a contention abort.
          return Response.json(
            { error: { code: 409, message: "Aborted due to cross-transaction contention", status: "ABORTED" } },
            { status: 409 },
          );
        }
        // Serializable isolation: if any document this transaction read has
        // changed since it read it, the commit aborts and the caller must
        // decide again. This is what stops two instances both observing "one
        // slot left" and both taking it.
        const readSet = body.transaction === undefined
          ? undefined
          : readSets.get(body.transaction);
        if (readSet !== undefined) {
          for (const [name, seen] of readSet) {
            if (versionOf(name) !== seen) {
              return Response.json(
                { error: { code: 409, message: "Aborted due to cross-transaction contention", status: "ABORTED" } },
                { status: 409 },
              );
            }
          }
        }
        commits.push(body.writes);
        // Faithful commit result. Firestore reports what each write did, and
        // for an `increment` transform that report is the POST-increment
        // value -- verified against the Firestore emulator, where three
        // successive commits returned transformResults of 1, then 2, then 3.
        // The quota's hard cap is enforced from these values, so a fixture
        // that omitted them would be testing a weaker service than the one
        // that ships.
        const writeResults = body.writes.map((write) => {
          if (typeof write.delete === "string") {
            counters.delete(write.delete);
            versions.set(write.delete, versionOf(write.delete) + 1);
            return { updateTime: "2026-09-01T00:00:00.000000Z" };
          }
          const name = (write.update as { name: string }).name;
          versions.set(name, versionOf(name) + 1);
          const transforms = (write.updateTransforms ?? []) as {
            increment?: { integerValue: string };
          }[];
          if (transforms.length === 0) {
            return { updateTime: "2026-09-01T00:00:00.000000Z" };
          }
          const transformResults = transforms.map((transform) => {
            const by = Number(transform.increment?.integerValue ?? "0");
            const next = (counters.get(name) ?? 0) + by;
            counters.set(name, next);
            return { integerValue: String(next) };
          });
          return { transformResults, updateTime: "2026-09-01T00:00:00.000000Z" };
        });
        return Response.json({ writeResults });
      }),
      projectId: "medlock-1025243085",
    });
  return {
    abort: (times: number) => {
      abortNext = times;
    },
    client,
    commits,
    counters,
    rollbacks,
    transactionCount: () => transactions,
  };
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

    await expect(quota.consume([RULE], AT)).rejects.toThrow("beginTransaction failed: 503");
  });

  test("a read that answers for fewer documents than it was asked is refused", async () => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet, async (input) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "txn" });
      if (url.endsWith(":rollback")) return Response.json({});
      // One document requested, none returned.
      return Response.json([]);
    });

    await expect(quota.consume([RULE], AT)).rejects.toThrow("incomplete result set");
  });

  test("a read that answers for a document nobody asked about is refused", async () => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet, async (input) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "txn" });
      if (url.endsWith(":rollback")) return Response.json({});
      return Response.json([{ missing: "projects/x/databases/(default)/documents/other/doc" }]);
    });

    await expect(quota.consume([RULE], AT)).rejects.toThrow("omitted a requested document");
  });

  test.each([
    ["non-numeric", { integerValue: "many" }],
    ["negative", { integerValue: "-1" }],
  ])("a counter read as %s is refused", async (_label, count) => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet, async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "txn" });
      if (url.endsWith(":rollback")) return Response.json({});
      const name = (JSON.parse(String(init?.body)) as { documents: string[] }).documents[0]!;
      return Response.json([{ found: { fields: { count }, name } }]);
    });

    await expect(quota.consume([RULE], AT)).rejects.toThrow("unusable counter");
  });

  test("sustained contention fails closed rather than guessing", async () => {
    const fleet = firestoreFleet();
    fleet.abort(99);
    const quota = quotaOf(fleet);

    // An instance that never got a clean commit has no idea what the budget is.
    await expect(quota.consume([RULE], AT)).rejects.toThrow("could not commit a decision");
    expect(fleet.commits).toEqual([]);
  });

  test("a contention abort is retried and then succeeds", async () => {
    const fleet = firestoreFleet();
    fleet.abort(2);
    const quota = quotaOf(fleet);

    await expect(quota.consume([RULE], AT)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(fleet.transactionCount()).toBe(3);
  });

  test("a refusal spends nothing at all", async () => {
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet);
    for (let index = 0; index < 3; index += 1) await quota.consume([RULE], AT);
    const commitsBefore = fleet.commits.length;

    const refused = await quota.consume([RULE], AT);

    expect(refused.allowed).toBe(false);
    // No write of any kind: the previous shape incremented first and judged
    // afterwards, so even a doomed request spent budget on its way to refusal.
    expect(fleet.commits.length).toBe(commitsBefore);
    expect(fleet.rollbacks).toHaveLength(1);
  });

  test("flooding one address cannot exhaust the shared budget", async () => {
    // The denial-of-service this fixes. `email` is narrow (3/hour) and `global`
    // is shared (60/minute). Under increment-then-judge, 200 attempts against
    // one address burned 200 units of the global budget and locked everybody
    // else out. Now the 4th attempt onwards costs the global bucket nothing.
    const fleet = firestoreFleet();
    const quota = quotaOf(fleet);
    const flood = (index: number) => [
      { key: "waitlist:global", limit: 60, windowSeconds: 60 },
      { key: `waitlist:email:${"a".repeat(32)}`, limit: 3, windowSeconds: 3_600 },
      { key: `waitlist:client:attacker-${index}`, limit: 5, windowSeconds: 60 },
    ];

    let allowed = 0;
    for (let index = 0; index < 200; index += 1) {
      if ((await quota.consume(flood(index), AT)).allowed) allowed += 1;
    }
    expect(allowed).toBe(3);

    // An unrelated client, same window, is still served.
    const bystander = await quota.consume([
      { key: "waitlist:global", limit: 60, windowSeconds: 60 },
      { key: `waitlist:email:${"b".repeat(32)}`, limit: 3, windowSeconds: 3_600 },
      { key: "waitlist:client:bystander", limit: 5, windowSeconds: 60 },
    ], AT);
    expect(bystander.allowed).toBe(true);

    // And the shared bucket only ever advanced for the four allowed requests.
    const globalKey = [...fleet.counters.keys()].find((name) =>
      name.includes("waitlist__global")
    )!;
    expect(fleet.counters.get(globalKey)).toBe(4);
  });

  test("a commit that landed but answered 503 is not retried", async () => {
    // The dangerous case. The server applied the writes and then failed to say
    // so. Treating that as "did not commit" would begin a fresh, non-idempotent
    // transaction and spend the budget a second time for one request.
    const fleet = firestoreFleet();
    let commits = 0;
    const quota = quotaOf(fleet, async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith(":beginTransaction")) return Response.json({ transaction: `txn-${commits}` });
      if (url.endsWith(":batchGet")) {
        const body = JSON.parse(String(init?.body)) as { documents: string[] };
        return Response.json(body.documents.map((name) => ({ missing: name })));
      }
      if (url.endsWith(":rollback")) return Response.json({});
      commits += 1;
      // Applied server-side; the answer is lost.
      return new Response("", { status: 503 });
    });

    await expect(quota.consume([RULE], AT)).rejects.toThrow("commit failed: 503");
    // Exactly one commit was attempted: ambiguity fails closed rather than
    // spending again.
    expect(commits).toBe(1);
  });

  test("a 429 is ambiguous too and is not retried", async () => {
    const fleet = firestoreFleet();
    let commits = 0;
    const quota = quotaOf(fleet, async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "txn" });
      if (url.endsWith(":batchGet")) {
        const body = JSON.parse(String(init?.body)) as { documents: string[] };
        return Response.json(body.documents.map((name) => ({ missing: name })));
      }
      if (url.endsWith(":rollback")) return Response.json({});
      commits += 1;
      return new Response("", { status: 429 });
    });

    await expect(quota.consume([RULE], AT)).rejects.toThrow("commit failed: 429");
    expect(commits).toBe(1);
  });

  test("a 409 that is not an ABORTED is refused rather than retried", async () => {
    const fleet = firestoreFleet();
    let commits = 0;
    const quota = quotaOf(fleet, async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "txn" });
      if (url.endsWith(":batchGet")) {
        const body = JSON.parse(String(init?.body)) as { documents: string[] };
        return Response.json(body.documents.map((name) => ({ missing: name })));
      }
      if (url.endsWith(":rollback")) return Response.json({});
      commits += 1;
      // A conflict, but not the one that states nothing was written.
      return Response.json({ error: { status: "ALREADY_EXISTS" } }, { status: 409 });
    });

    await expect(quota.consume([RULE], AT)).rejects.toThrow("unrecognised conflict");
    expect(commits).toBe(1);
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
