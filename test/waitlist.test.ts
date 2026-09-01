import { describe, expect, test } from "bun:test";
import { FirestoreClient, type FetchLike } from "../src/firestore.ts";
import {
  waitlistEntryFromUnknown,
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
        // The exact payload Firestore returns, captured from the emulator.
        // The `code` is part of it, and the parser insists on it: a body that
        // omits the code is not a well-formed statement about the write.
        return Response.json({
          error: {
            code: 409,
            message: "entity already exists: EntityRef[partitionRef=dev~p, path=/waitlist/x]",
            status: "ALREADY_EXISTS",
          },
        }, { status: 409 });
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

  test("the file store refuses to confirm rather than racing two promotions", async () => {
    // Read-then-write has no compare-and-swap, so two concurrent confirmations
    // would both succeed and the second subject would overwrite the first --
    // contradicting the single-use interface. Refusing is the honest answer.
    const directory = `/tmp/medlock-confirm-${crypto.randomUUID()}`;
    const store = new FileWaitlistStore(directory);
    await submitWaitlist(store, { clientId: "c", email: "confirm@example.com" }, new Date(AT));

    await expect(store.confirm()).rejects.toThrow("no compare-and-swap");
    // And the entry is untouched.
    expect((await store.read(HASH))!.status).toBe("pending");
  });
});

describe("waitlist record validation", () => {
  const EMAIL = "record@example.com";
  const HASH2 = new Bun.CryptoHasher("sha256").update(EMAIL).digest("hex");
  const sound = () => ({
    clientHash: "c".repeat(64),
    confirmedAt: null,
    confirmedSubject: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    email: EMAIL,
    emailHash: HASH2,
    expiresAt: "2026-10-01T12:00:00.000Z",
    source: "site",
    status: "pending",
    userAgentHash: "u".repeat(64),
  });

  test("a sound record validates", () => {
    expect(waitlistEntryFromUnknown(sound(), HASH2).status).toBe("pending");
  });

  test.each([
    ["a missing expiry", { expiresAt: undefined }],
    ["an empty expiry", { expiresAt: "" }],
    ["an unparseable expiry", { expiresAt: "whenever" }],
    ["a non-canonical expiry", { expiresAt: "2026-10-01T12:00:00Z" }],
  ])("%s is refused rather than read as unexpired", (_label, patch) => {
    // The fail-open shape: Date.parse yields NaN, `NaN <= now` is false, and the
    // record was treated as unexpired and promoted.
    expect(() => waitlistEntryFromUnknown({ ...sound(), ...patch }, HASH2)).toThrow();
  });

  test.each([
    ["an unknown status", { status: "verified" }],
    ["a missing status", { status: undefined }],
    ["a numeric status", { status: 1 }],
  ])("%s is refused rather than coerced to pending", (_label, patch) => {
    expect(() => waitlistEntryFromUnknown({ ...sound(), ...patch }, HASH2))
      .toThrow("not a recognised state");
  });

  test("a hash that does not match its email is refused", () => {
    expect(() => waitlistEntryFromUnknown({ ...sound(), emailHash: "d".repeat(64) }, "d".repeat(64)))
      .toThrow("does not match its email");
  });

  test("a record for another address is refused even if internally consistent", () => {
    // Document identity and contents must agree, or confirming one address
    // would confirm another.
    const other = "other@example.com";
    const record = {
      ...sound(),
      email: other,
      emailHash: new Bun.CryptoHasher("sha256").update(other).digest("hex"),
    };
    expect(() => waitlistEntryFromUnknown(record, HASH2))
      .toThrow("does not belong to the requested address");
  });

  test("an unnormalised email is refused", () => {
    const upper = "Record@Example.COM";
    const record = {
      ...sound(),
      email: upper,
      emailHash: new Bun.CryptoHasher("sha256").update(upper).digest("hex"),
    };
    expect(() => waitlistEntryFromUnknown(record, record.emailHash)).toThrow("not normalised");
  });

  test.each([
    ["pending but confirmed", { confirmedAt: "2026-09-01T12:00:00.000Z", status: "pending" }],
    ["pending but has a subject", { confirmedSubject: "s", status: "pending" }],
    ["confirmed but has no confirmation", { status: "confirmed" }],
  ])("a record that is %s is refused", (_label, patch) => {
    expect(() => waitlistEntryFromUnknown({ ...sound(), ...patch }, HASH2)).toThrow();
  });

});

describe("waitlist confirmation concurrency", () => {
  const EMAIL = "race@example.com";
  const HASH3 = new Bun.CryptoHasher("sha256").update(EMAIL).digest("hex");
  const AT3 = Date.parse("2026-09-01T12:00:00.000Z");

  test("two genuinely interleaved confirmations produce exactly one promotion", async () => {
    // A barrier, not two sequential calls. Both transactions read the pending
    // entry BEFORE either commits, which is the interleaving that read-then-
    // write cannot survive: without a compare-and-swap both would report
    // confirmed and the second subject would overwrite the first.
    let version = 1;
    let readers = 0;
    let releaseBarrier: () => void = () => {};
    const bothHaveRead = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const commits: string[] = [];
    const versionStamp = (n: number) => `2026-09-01T12:00:0${n}.000000Z`;
    let record: Record<string, unknown> = {
      clientHash: "c".repeat(64),
      createdAt: "2026-09-01T12:00:00.000Z",
      email: EMAIL,
      emailHash: HASH3,
      expiresAt: "2026-10-01T12:00:00.000Z",
      source: "site",
      status: "pending",
      userAgentHash: "u".repeat(64),
    };
    const INSTANT_FIELDS = new Set(["confirmedAt", "createdAt", "expiresAt"]);
    const toFields = () =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) =>
          INSTANT_FIELDS.has(key)
            ? [key, { timestampValue: String(value) }]
            : [key, { stringValue: String(value) }]
        ),
      );

    const fetcher: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (!url.endsWith(":commit")) {
        // A plain document read. Firestore returns the document's version
        // alongside its fields, and that version is what the promotion below
        // pins itself to.
        readers += 1;
        const observed = version;
        // Hold until both readers have seen the same pending state.
        if (readers >= 2) releaseBarrier();
        else await bothHaveRead;
        return Response.json({
          fields: toFields(),
          name: url.split("/documents/")[1],
          updateTime: versionStamp(observed),
        });
      }
      const body = JSON.parse(String(init?.body)) as {
        writes: {
          currentDocument?: { updateTime?: string };
          update: {
            fields: Record<string, { stringValue?: string; timestampValue?: string }>;
          };
        }[];
      };
      const write = body.writes[0]!;
      // The compare-and-swap, exactly as Firestore performs it. A write whose
      // required base version is not the stored version is refused; observed
      // verbatim from the Firestore emulator:
      //   400 {"error":{"code":400,"message":"the stored version (...) does
      //        not match the required base version (...)",
      //        "status":"FAILED_PRECONDITION"}}
      if (write.currentDocument?.updateTime !== versionStamp(version)) {
        return Response.json(
          {
            error: {
              code: 400,
              message: "the stored version (2) does not match the required base version (1)",
              status: "FAILED_PRECONDITION",
            },
          },
          { status: 400 },
        );
      }
      version += 1;
      commits.push(String(write.currentDocument?.updateTime));
      // Firestore stores instants as timestampValue and text as stringValue;
      // a fixture that only reads one of them is not modelling the store.
      record = Object.fromEntries(
        Object.entries(write.update.fields).map(([key, value]) => [
          key,
          value.stringValue ?? value.timestampValue,
        ]),
      );
      return Response.json({ writeResults: [{ updateTime: versionStamp(version) }] });
    };

    const store = new FirestoreWaitlistStore({
      client: new FirestoreClient({
        databaseId: "(default)",
        fetcher,
        projectId: "medlock-1025243085",
      }),
      collection: "waitlist",
    });

    const [first, second] = await Promise.all([
      store.confirm(HASH3, "subject-first", AT3 + 1_000),
      store.confirm(HASH3, "subject-second", AT3 + 1_000),
    ]);

    // Exactly one promotion, whichever won; the loser sees the committed state.
    expect([first, second].filter((outcome) => outcome === "confirmed")).toHaveLength(1);
    expect([first, second].filter((outcome) => outcome === "already-confirmed")).toHaveLength(1);
    // And exactly one write reached the store.
    expect(commits).toHaveLength(1);
    expect(record.status).toBe("confirmed");
  });
});
