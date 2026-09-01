import { describe, expect, test } from "bun:test";
import { FirestoreClient, type FetchLike } from "../src/firestore.ts";
import { FirestoreWaitlistQuota } from "../src/waitlist-quota.ts";
import { FirestoreWaitlistStore } from "../src/waitlist.ts";
import {
  TTL_FIELD,
  ttlCollections,
  ttlPolicyIsEnforced,
  ttlStateFromField,
} from "../src/ttl-policy.ts";

// The shape below is the live Firestore Admin API response for a field with no
// TTL policy, captured from this project. It is the state the database is
// actually in, and the point of the check is that it is not mistaken for
// success.
const FIELD_WITHOUT_TTL = {
  indexConfig: {
    indexes: [
      { fields: [{ fieldPath: "expiresAt", order: "ASCENDING" }], queryScope: "COLLECTION" },
      { fields: [{ fieldPath: "expiresAt", order: "DESCENDING" }], queryScope: "COLLECTION" },
    ],
  },
  name: "projects/p/databases/(default)/collectionGroups/waitlist/fields/expiresAt",
};

describe("ttl policy state", () => {
  test("a field carrying only indexes has no TTL, however many indexes it has", () => {
    expect(ttlStateFromField(FIELD_WITHOUT_TTL)).toBe("absent");
    expect(ttlPolicyIsEnforced(ttlStateFromField(FIELD_WITHOUT_TTL))).toBe(false);
  });

  test("only an ACTIVE policy counts as enforced", () => {
    const states: readonly (readonly [unknown, string, boolean])[] = [
      [{ ...FIELD_WITHOUT_TTL, ttlConfig: { state: "ACTIVE" } }, "active", true],
      // Still building: nothing has been reaped yet, so reporting success here
      // would claim a bound that is not being applied.
      [{ ...FIELD_WITHOUT_TTL, ttlConfig: { state: "CREATING" } }, "creating", false],
      // Firestore gave up part way through.
      [{ ...FIELD_WITHOUT_TTL, ttlConfig: { state: "NEEDS_REPAIR" } }, "needs-repair", false],
    ];
    for (const [field, expected, enforced] of states) {
      expect(ttlStateFromField(field)).toBe(expected as never);
      expect(ttlPolicyIsEnforced(ttlStateFromField(field))).toBe(enforced);
    }
  });

  test("a malformed ttlConfig is never read as an active policy", () => {
    const malformed: readonly unknown[] = [
      { ttlConfig: {} },
      { ttlConfig: { state: "" } },
      { ttlConfig: { state: "active" } },
      { ttlConfig: { state: 1 } },
      { ttlConfig: null },
      { ttlConfig: [] },
      { ttlConfig: "ACTIVE" },
      null,
      [],
      "ACTIVE",
      42,
    ];
    for (const field of malformed) {
      expect(ttlPolicyIsEnforced(ttlStateFromField(field))).toBe(false);
    }
  });

  test("both collections the service writes are covered, derived from configuration", () => {
    expect(ttlCollections("waitlist")).toEqual(["waitlist", "waitlist_quota"]);
    expect(ttlCollections("wl_preview")).toEqual(["wl_preview", "wl_preview_quota"]);
  });
});

// TTL reaps timestamps. A field written as a string is ignored outright -- no
// error, no deletion -- so the encoding is part of the bound, not a detail.
describe("expiresAt is stored as a timestamp everywhere it is written", () => {
  function capturing(bodies: string[]): FetchLike {
    return async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.endsWith(":beginTransaction")) return Response.json({ transaction: "t" });
      if (url.endsWith(":batchGet")) {
        const body = JSON.parse(String(init?.body)) as { documents: string[] };
        bodies.push(String(init?.body));
        return Response.json(body.documents.map((name) => ({ missing: name })));
      }
      if (url.endsWith(":rollback")) return Response.json({});
      bodies.push(String(init?.body));
      const parsed = JSON.parse(String(init?.body)) as { writes?: unknown[] };
      return Response.json({
        writeResults: (parsed.writes ?? []).map(() => ({
          transformResults: [{ integerValue: "1" }],
        })),
      });
    };
  }

  test("a created waitlist entry writes expiresAt as timestampValue", async () => {
    const bodies: string[] = [];
    const store = new FirestoreWaitlistStore({
      client: new FirestoreClient({
        databaseId: "(default)",
        fetcher: capturing(bodies),
        projectId: "p",
      }),
      collection: "waitlist",
    });
    await store.create({
      clientHash: "c".repeat(64),
      confirmedAt: null,
      confirmedSubject: null,
      createdAt: "2026-09-01T12:00:00.000Z",
      email: "ttl@example.com",
      emailHash: new Bun.CryptoHasher("sha256").update("ttl@example.com").digest("hex"),
      expiresAt: "2026-10-01T12:00:00.000Z",
      source: "site",
      status: "pending",
      userAgentHash: "u".repeat(64),
    });
    const written = JSON.parse(bodies.at(-1)!) as {
      fields: Record<string, Record<string, string>>;
    };
    expect(written.fields[TTL_FIELD]).toEqual({ timestampValue: "2026-10-01T12:00:00.000Z" });
    expect(written.fields[TTL_FIELD]?.stringValue).toBeUndefined();
  });

  test("a quota bucket writes expiresAt as timestampValue", async () => {
    const bodies: string[] = [];
    const quota = new FirestoreWaitlistQuota({
      client: new FirestoreClient({
        databaseId: "(default)",
        fetcher: capturing(bodies),
        projectId: "p",
      }),
      collection: "waitlist_quota",
    });
    const decision = await quota.consume(
      [{ key: "global", limit: 10, windowSeconds: 60 }],
      new Date("2026-09-01T12:00:00.000Z"),
    );
    expect(decision.allowed).toBe(true);
    const committed = JSON.parse(bodies.at(-1)!) as {
      writes: { update?: { fields?: Record<string, Record<string, string>> } }[];
    };
    const fields = committed.writes[0]?.update?.fields ?? {};
    expect(Object.keys(fields)).toEqual([TTL_FIELD]);
    expect(fields[TTL_FIELD]?.timestampValue).toBeString();
    expect(fields[TTL_FIELD]?.stringValue).toBeUndefined();
  });
});
