import { describe, expect, test } from "bun:test";
import { FirestoreClient } from "../src/firestore.ts";
import { firestoreErrorIs, parseFirestoreApiError } from "../src/firestore-error.ts";

// Payloads captured verbatim from a running Firestore emulator and from the
// live Firestore API, so these are the shapes the service will actually meet
// rather than shapes invented to match the parser.
const REAL_ABORTED =
  '{"error":{"code":409,"message":"Transaction lock timeout.","status":"ABORTED"}}';
const REAL_ALREADY_EXISTS =
  '{"error":{"code":409,"message":"entity already exists: EntityRef[partitionRef=dev~demo-p, path=\\/c\\/dup]","status":"ALREADY_EXISTS"}}';
const REAL_FAILED_PRECONDITION =
  '{"error":{"code":400,"message":"the stored version (1788288942985905) does not match the required base version (1788288942932378)","status":"FAILED_PRECONDITION"}}';
const REAL_INVALID_ARGUMENT =
  '{"error":{"code":400,"message":"Invalid transaction.","status":"INVALID_ARGUMENT"}}';

describe("firestore error envelope", () => {
  test("decodes the real payloads Firestore actually sends", () => {
    expect(parseFirestoreApiError(409, REAL_ABORTED)?.status).toBe("ABORTED");
    expect(parseFirestoreApiError(409, REAL_ALREADY_EXISTS)?.status).toBe("ALREADY_EXISTS");
    expect(parseFirestoreApiError(400, REAL_FAILED_PRECONDITION)?.status).toBe(
      "FAILED_PRECONDITION",
    );
    expect(parseFirestoreApiError(400, REAL_INVALID_ARGUMENT)?.status).toBe("INVALID_ARGUMENT");
  });

  // The whole reason this is a parser and not an includes() call: ABORTED and
  // ALREADY_EXISTS are BOTH HTTP 409 and differ only in `status`.
  test("separates the two 409s that a status code alone cannot", () => {
    expect(firestoreErrorIs(409, REAL_ABORTED, "ABORTED")).toBe(true);
    expect(firestoreErrorIs(409, REAL_ABORTED, "ALREADY_EXISTS")).toBe(false);
    expect(firestoreErrorIs(409, REAL_ALREADY_EXISTS, "ALREADY_EXISTS")).toBe(true);
    expect(firestoreErrorIs(409, REAL_ALREADY_EXISTS, "ABORTED")).toBe(false);
  });

  // Each of these contains the literal text ABORTED and would pass a substring
  // test, while stating something entirely different -- or nothing at all.
  describe("text that defeats substring matching", () => {
    const decoys: readonly (readonly [string, string])[] = [
      [
        "the word appears in the message of a different status",
        '{"error":{"code":409,"message":"write ABORTED? no: entity already exists","status":"ALREADY_EXISTS"}}',
      ],
      [
        "the word appears in an echoed resource path",
        '{"error":{"code":409,"message":"entity already exists: path=/waitlist/ABORTED","status":"ALREADY_EXISTS"}}',
      ],
      [
        "a proxy returned an HTML page that mentions it",
        "<html><body><h1>409 Conflict</h1><p>upstream ABORTED</p></body></html>",
      ],
      [
        "a bare quoted token with no envelope at all",
        '"ABORTED"',
      ],
      [
        "the word is a key rather than the status",
        '{"error":{"code":409,"message":"x","status":"ALREADY_EXISTS","ABORTED":true}}',
      ],
    ];
    for (const [name, body] of decoys) {
      test(name, () => {
        expect(body).toContain("ABORTED");
        expect(firestoreErrorIs(409, body, "ABORTED")).toBe(false);
      });
    }
  });

  // A body is only evidence if it is internally consistent. Anything else is
  // treated as no statement at all, which callers turn into a fail-closed
  // error rather than a retry.
  describe("rejects envelopes that are not self-consistent", () => {
    const rejected: readonly (readonly [string, number, string])[] = [
      ["envelope code disagrees with the transport status", 409, '{"error":{"code":400,"status":"ABORTED"}}'],
      ["status is impossible at this HTTP status", 503, '{"error":{"code":503,"status":"ABORTED"}}'],
      ["status is lowercase", 409, '{"error":{"code":409,"status":"aborted"}}'],
      ["status is a near-miss of a real one", 409, '{"error":{"code":409,"status":"ABORTED_RETRY"}}'],
      ["status carries surrounding whitespace", 409, '{"error":{"code":409,"status":" ABORTED "}}'],
      ["code is a string rather than a number", 409, '{"error":{"code":"409","status":"ABORTED"}}'],
      ["code is fractional", 409, '{"error":{"code":409.5,"status":"ABORTED"}}'],
      ["code is missing entirely", 409, '{"error":{"status":"ABORTED"}}'],
      ["status is missing entirely", 409, '{"error":{"code":409}}'],
      ["error is a string", 409, '{"error":"ABORTED"}'],
      ["error is an array", 409, '{"error":[{"code":409,"status":"ABORTED"}]}'],
      ["error is null", 409, '{"error":null}'],
      ["envelope is an array", 409, '[{"error":{"code":409,"status":"ABORTED"}}]'],
      ["envelope is a bare null", 409, "null"],
      ["status sits at the top level instead of inside error", 409, '{"code":409,"status":"ABORTED"}'],
      ["body is empty", 409, ""],
      ["body is not JSON", 409, "ABORTED"],
      ["body is truncated JSON", 409, '{"error":{"code":409,"status":"ABOR'],
    ];
    for (const [name, status, body] of rejected) {
      test(name, () => {
        expect(parseFirestoreApiError(status, body)).toBeUndefined();
        expect(firestoreErrorIs(status, body, "ABORTED")).toBe(false);
      });
    }
  });

  test("refuses an error body large enough to be a denial of service on its own", () => {
    const padding = "A".repeat(64 * 1024);
    const body = `{"error":{"code":409,"message":"${padding}","status":"ABORTED"}}`;
    expect(body.length).toBeGreaterThan(64 * 1024);
    expect(parseFirestoreApiError(409, body)).toBeUndefined();
  });

  test("a prototype-polluting key cannot forge a status", () => {
    const body = '{"__proto__":{"error":{"code":409,"status":"ABORTED"}}}';
    expect(parseFirestoreApiError(409, body)).toBeUndefined();
    expect(({} as Record<string, unknown>).error).toBeUndefined();
  });

  test("a nonsensical transport status is never decoded", () => {
    expect(parseFirestoreApiError(0, REAL_ABORTED)).toBeUndefined();
    expect(parseFirestoreApiError(999, REAL_ABORTED)).toBeUndefined();
    expect(parseFirestoreApiError(Number.NaN, REAL_ABORTED)).toBeUndefined();
  });

  test("a missing message decodes without inventing one", () => {
    const parsed = parseFirestoreApiError(409, '{"error":{"code":409,"status":"ABORTED"}}');
    expect(parsed?.status).toBe("ABORTED");
    expect(parsed?.message).toBe("");
  });
});


// The parser being correct is not the same as the client using it. These drive
// the real FirestoreClient methods with the decoy bodies, because the decision
// that matters -- "was this a duplicate", "did this commit" -- is made there.
describe("the client decides from the decoded status, not the status code", () => {
  function clientReturning(status: number, body: string) {
    return new FirestoreClient({
      databaseId: "(default)",
      fetcher: async (input) => {
        if (String(input).includes("metadata.google.internal")) {
          return Response.json({ access_token: "t", expires_in: 3600 });
        }
        return new Response(body, {
          headers: { "Content-Type": "application/json" },
          status,
        });
      },
      projectId: "p",
    });
  }

  test("create reports a duplicate only for ALREADY_EXISTS", async () => {
    expect(await clientReturning(409, REAL_ALREADY_EXISTS).create("c", "d", { fields: {} }))
      .toBe("duplicate");
  });

  // Contention is not a duplicate. Reporting it as one would tell a caller the
  // address is already registered when nothing of the sort was established --
  // an enumeration oracle any attacker can trigger by generating load.
  test("create refuses to read a contended 409 as a duplicate", async () => {
    await expect(clientReturning(409, REAL_ABORTED).create("c", "d", { fields: {} }))
      .rejects.toThrow(/not ALREADY_EXISTS/);
  });

  test("create refuses a 409 whose body proves nothing", async () => {
    for (const body of ["", "<html>409 ALREADY_EXISTS</html>", '{"error":{"status":"ALREADY_EXISTS"}}']) {
      await expect(clientReturning(409, body).create("c", "d", { fields: {} }))
        .rejects.toThrow(/not ALREADY_EXISTS/);
    }
  });

  test("commitTransaction reports not-committed only for ABORTED", async () => {
    expect(await clientReturning(409, REAL_ABORTED).commitTransaction("t", []))
      .toEqual({ committed: false });
  });

  // The dangerous direction: `committed: false` makes the caller re-run a
  // non-idempotent transaction. A 409 that is not an ABORTED must never
  // produce it.
  test("commitTransaction refuses to read ALREADY_EXISTS as a clean abort", async () => {
    await expect(clientReturning(409, REAL_ALREADY_EXISTS).commitTransaction("t", []))
      .rejects.toThrow(/unrecognised conflict/);
  });

  test("commitTransaction is not fooled by the word ABORTED in a message", async () => {
    const decoy =
      '{"error":{"code":409,"message":"write ABORTED? no: entity already exists","status":"ALREADY_EXISTS"}}';
    expect(decoy).toContain("ABORTED");
    await expect(clientReturning(409, decoy).commitTransaction("t", []))
      .rejects.toThrow(/unrecognised conflict/);
  });

  test("commitTransaction is not fooled by a proxy page mentioning ABORTED", async () => {
    await expect(
      clientReturning(409, "<html><body>upstream ABORTED</body></html>").commitTransaction("t", []),
    ).rejects.toThrow(/unrecognised conflict/);
  });

  // Ambiguity is not a claim that nothing was written.
  test("commitTransaction never treats an ambiguous status as not-committed", async () => {
    for (const status of [429, 500, 503, 504]) {
      await expect(clientReturning(status, "{}").commitTransaction("t", []))
        .rejects.toThrow(/commit failed/);
    }
  });
});
