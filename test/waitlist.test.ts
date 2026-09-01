import { describe, expect, test } from "bun:test";
import { FirestoreClient, type FetchLike } from "../src/firestore.ts";
import {
  FileWaitlistStore,
  FirestoreWaitlistStore,
  MemoryWaitlistStore,
  normalizeEmail,
  submitWaitlist,
} from "../src/waitlist.ts";

const EMAIL_HASH = new Bun.CryptoHasher("sha256").update("person@example.com").digest("hex");

describe("waitlist", () => {
  test("normalizes and stores a valid email once", async () => {
    const store = new MemoryWaitlistStore();
    const first = await submitWaitlist(
      store,
      {
        clientId: "signed-client-one",
        email: "  Person@Example.COM ",
        source: "test",
        userAgent: "bun-test",
      },
      new Date("2026-06-01T12:00:00.000Z"),
    );
    const duplicate = await submitWaitlist(store, {
      clientId: "signed-client-one",
      email: "person@example.com",
    });

    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (first.ok && duplicate.ok) {
      // The outcome exists so the process can tell the two apart. It never
      // leaves the process.
      expect(first.outcome).toBe("created");
      expect(duplicate.outcome).toBe("duplicate");
    }
    expect(store.size).toBe(1);
    expect(store.peek(EMAIL_HASH)?.email).toBe("person@example.com");
  });

  test("stores a submission as pending with a TTL and never as confirmed", async () => {
    const store = new MemoryWaitlistStore();
    await submitWaitlist(
      store,
      { clientId: "signed-client-ttl", email: "pending@example.com" },
      new Date("2026-06-01T12:00:00.000Z"),
    );
    const stored = store.peek(
      new Bun.CryptoHasher("sha256").update("pending@example.com").digest("hex"),
    );

    expect(stored?.status).toBe("pending");
    expect(stored?.confirmedAt).toBeNull();
    // An unverified claim expires on its own rather than ageing into a member.
    expect(stored?.expiresAt).toBe("2026-07-01T12:00:00.000Z");
  });

  test("rejects invalid emails", async () => {
    const result = await submitWaitlist(new MemoryWaitlistStore(), {
      clientId: "signed-client-two",
      email: "not-email",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  test("normalizes email casing consistently", () => {
    expect(normalizeEmail(" Collin@Example.Com ")).toBe("collin@example.com");
  });

  test("creates through Firestore with create-if-absent and reads 409 as duplicate", async () => {
    const requestedUrls: string[] = [];
    let existing = false;
    const fetcher: FetchLike = async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }

      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
      // documentId in the query string is what makes this a create, not a
      // write: Firestore refuses it if the document is already there.
      expect(url).toContain("documentId=");
      const document = JSON.parse(String(init?.body)) as {
        fields?: Record<string, { stringValue?: string; timestampValue?: string }>;
      };
      expect(document.fields?.clientHash?.stringValue).toMatch(/^[0-9a-f]{64}$/);
      expect(document.fields?.status?.stringValue).toBe("pending");
      expect(document.fields?.expiresAt?.timestampValue).toBe("2026-07-01T12:00:00.000Z");
      expect(document.fields?.confirmedAt).toBeUndefined();
      if (existing) {
        return Response.json({ error: { status: "ALREADY_EXISTS" } }, { status: 409 });
      }
      existing = true;
      return Response.json({ name: "stored" });
    };
    const store = new FirestoreWaitlistStore({
      client: new FirestoreClient({ databaseId: "(default)", fetcher, projectId: "medlock-1025243085" }),
      collection: "waitlist_preview_12",
    });

    const submission = { clientId: "signed-firestore-client", email: "firestore@example.com" };
    const at = new Date("2026-06-01T12:00:00.000Z");
    const first = await submitWaitlist(store, submission, at);
    const second = await submitWaitlist(store, submission, at);

    expect(first.ok && first.outcome).toBe("created");
    expect(second.ok && second.outcome).toBe("duplicate");
    // Never a read before the write: the only requests are the token fetch and
    // the two creates.
    expect(requestedUrls.filter((url) => url.includes("/documents/waitlist_preview_12"))).toHaveLength(2);
    expect(requestedUrls.every((url) => !url.match(/documents\/waitlist_preview_12\/[0-9a-f]{64}$/))).toBe(true);
  });

});

describe("waitlist confirmation", () => {
  const HASH = new Bun.CryptoHasher("sha256").update("confirm@example.com").digest("hex");
  const AT = Date.parse("2026-09-01T12:00:00.000Z");
  const seed = async () => {
    const store = new MemoryWaitlistStore();
    await submitWaitlist(store, { clientId: "c", email: "confirm@example.com" }, new Date(AT));
    return store;
  };

  test("a pending entry is promoted exactly once", async () => {
    const store = await seed();
    expect(await store.confirm(HASH, "subject-1", AT + 1_000)).toBe("confirmed");
    const entry = store.peek(HASH)!;
    expect(entry.status).toBe("confirmed");
    expect(entry.confirmedSubject).toBe("subject-1");
    expect(entry.confirmedAt).toBe("2026-09-01T12:00:01.000Z");
  });

  test("a replayed confirmation does not promote again or change the record", async () => {
    const store = await seed();
    await store.confirm(HASH, "subject-1", AT + 1_000);
    const afterFirst = { ...store.peek(HASH)! };

    // A second proof for the same address -- a replayed token, or a different
    // subject presenting one -- must not reset state or rewrite who confirmed.
    expect(await store.confirm(HASH, "subject-2", AT + 2_000)).toBe("already-confirmed");
    expect(store.peek(HASH)).toEqual(afterFirst);
  });

  test("confirmation clears the expiry so a member is not reaped", async () => {
    const store = await seed();
    expect(Date.parse(store.peek(HASH)!.expiresAt)).toBeLessThan(AT + 40 * 24 * 60 * 60_000);
    await store.confirm(HASH, "subject-1", AT + 1_000);
    // The field stays present for the TTL policy to read, but names an instant
    // the policy will never reach.
    expect(Date.parse(store.peek(HASH)!.expiresAt)).toBeGreaterThan(AT + 100 * 365 * 24 * 60 * 60_000);
  });

  test("an expired pending entry cannot be confirmed", async () => {
    const store = await seed();
    const expired = Date.parse(store.peek(HASH)!.expiresAt) + 1_000;
    expect(await store.confirm(HASH, "subject-1", expired)).toBe("expired");
    expect(store.peek(HASH)!.status).toBe("pending");
  });

  test("confirming an address that was never submitted reports absent", async () => {
    const store = await seed();
    const other = new Bun.CryptoHasher("sha256").update("nobody@example.com").digest("hex");
    expect(await store.confirm(other, "subject-1", AT + 1_000)).toBe("absent");
  });

  test("the file store promotes and replays identically", async () => {
    const directory = `/tmp/medlock-confirm-${Bun.hash(String(AT))}`;
    const store = new FileWaitlistStore(directory);
    await submitWaitlist(store, { clientId: "c", email: "confirm@example.com" }, new Date(AT));

    expect(await store.confirm(HASH, "subject-1", AT + 1_000)).toBe("confirmed");
    expect(await store.confirm(HASH, "subject-2", AT + 2_000)).toBe("already-confirmed");
    const entry = (await store.read(HASH))!;
    expect(entry.status).toBe("confirmed");
    expect(entry.confirmedSubject).toBe("subject-1");
  });
});
