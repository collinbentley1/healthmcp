import { firestoreErrorIs } from "./firestore-error.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FirestoreCreateOutcome = "created" | "duplicate";

// A committed transaction carries back what its transforms produced, aligned
// with the writes that were sent. `increment` is a single-document atomic
// transform, so the value returned here is the authoritative post-increment
// count -- which is what lets a caller enforce a hard cap without depending on
// any cross-document isolation guarantee.
export type FirestoreCommitOutcome =
  | { readonly committed: true; readonly transformResults: readonly (readonly FirestoreValue[])[] }
  | { readonly committed: false };

export type FirestoreValue =
  | { readonly integerValue: string }
  | { readonly stringValue: string }
  | { readonly timestampValue: string };

export type FirestoreDocument = {
  readonly fields?: Record<string, FirestoreValue>;
  readonly name?: string;
  // Firestore's per-document version. Passed back as a write precondition it
  // becomes a compare-and-swap that holds on the single-document write path,
  // independent of any transaction. Verified against the Firestore emulator:
  // replaying a stale updateTime is refused with
  //   400 {"error":{"code":400,"message":"the stored version (...) does not
  //        match the required base version (...)","status":"FAILED_PRECONDITION"}}
  readonly updateTime?: string;
};

// Whether a conditional write took effect. `precondition-failed` is a positive
// statement that the document moved since it was read, so the caller must
// re-read rather than retry the same write.
export type FirestoreConditionalOutcome = "committed" | "precondition-failed";

// One Firestore client for every collection this service touches, so the
// metadata-server token is fetched and cached once rather than per store.
export class FirestoreClient {
  readonly #databaseId: string;
  readonly #fetch: FetchLike;
  readonly #projectId: string;
  #token: { readonly accessToken: string; readonly expiresAt: number } | undefined;

  constructor(options: { databaseId: string; fetcher?: FetchLike; projectId: string }) {
    this.#databaseId = options.databaseId;
    this.#fetch = options.fetcher ?? fetch;
    this.#projectId = options.projectId;
  }

  get documentsBaseUrl(): string {
    return `https://firestore.googleapis.com/v1/${this.documentsBasePath}`;
  }

  get documentsBasePath(): string {
    return `projects/${this.#projectId}/databases/${encodePathSegment(this.#databaseId)}/documents`;
  }

  documentName(collection: string, documentId: string): string {
    return `${this.documentsBasePath}/${encodePathSegment(collection)}/${encodePathSegment(documentId)}`;
  }

  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.#accessToken()}` };
  }

  async get(collection: string, documentId: string): Promise<FirestoreDocument | undefined> {
    const response = await this.#fetch(
      `${this.documentsBaseUrl}/${encodePathSegment(collection)}/${encodePathSegment(documentId)}`,
      { headers: await this.headers() },
    );
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Firestore read failed: ${response.status}`);
    }
    return (await response.json()) as FirestoreDocument;
  }

  // Create-if-absent, decided by Firestore rather than by a read followed by a
  // write. The 409 is the whole point: it is the only outcome that proves the
  // document was already there, and it costs the same one round trip as the
  // success case.
  async create(
    collection: string,
    documentId: string,
    document: FirestoreDocument,
  ): Promise<FirestoreCreateOutcome> {
    const response = await this.#fetch(
      `${this.documentsBaseUrl}/${encodePathSegment(collection)}?documentId=${encodeURIComponent(documentId)}`,
      {
        body: JSON.stringify(document),
        headers: { ...(await this.headers()), "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
      },
    );
    if (response.status === 409) {
      // ALREADY_EXISTS and ABORTED are both 409. Reporting a contended write
      // as a duplicate would be worse than a lost signup: "duplicate" is
      // exactly the answer that tells a caller the address is already on the
      // list, so inferring it from contention hands back an enumeration
      // oracle that an attacker can trigger on demand by generating load.
      const detail = await response.text().catch(() => "");
      if (firestoreErrorIs(409, detail, "ALREADY_EXISTS")) {
        return "duplicate";
      }
      throw new Error("Firestore create returned a conflict that is not ALREADY_EXISTS");
    }
    if (!response.ok) {
      throw new Error(`Firestore create failed: ${response.status}`);
    }
    return "created";
  }

  // Serializable transactions.
  //
  // A bare commit with `increment` transforms advances every counter and only
  // then reports what it did, so a request that was always going to be refused
  // still spends budget on its way to being refused. That is a denial-of-
  // service primitive: flooding one narrow bucket drains the shared one. A
  // transaction lets the counters be READ, judged, and only then advanced --
  // and Firestore aborts the commit if anything the read touched changed
  // underneath it, so two racing instances cannot both pass the same check.
  async beginTransaction(): Promise<string> {
    const response = await this.#fetch(`${this.documentsBaseUrl}:beginTransaction`, {
      body: JSON.stringify({ options: { readWrite: {} } }),
      headers: { ...(await this.headers()), "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Firestore beginTransaction failed: ${response.status}`);
    }
    const body = (await response.json()) as { transaction?: unknown };
    if (typeof body.transaction !== "string" || body.transaction.length === 0) {
      throw new Error("Firestore beginTransaction returned no transaction token");
    }
    return body.transaction;
  }

  // Reads inside the transaction, so the commit that follows is conditional on
  // these exact documents not having moved.
  async batchGet(
    names: readonly string[],
    transaction: string,
  ): Promise<ReadonlyMap<string, FirestoreDocument | undefined>> {
    const response = await this.#fetch(`${this.documentsBaseUrl}:batchGet`, {
      body: JSON.stringify({ documents: names, transaction }),
      headers: { ...(await this.headers()), "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Firestore batchGet failed: ${response.status}`);
    }
    const results = (await response.json()) as readonly {
      readonly found?: {
        readonly fields?: Record<string, FirestoreValue>;
        readonly name: string;
        readonly updateTime?: string;
      };
      readonly missing?: string;
    }[];
    if (!Array.isArray(results) || results.length !== names.length) {
      throw new Error("Firestore batchGet returned an incomplete result set");
    }
    const documents = new Map<string, FirestoreDocument | undefined>();
    for (const entry of results) {
      if (typeof entry.missing === "string") {
        documents.set(entry.missing, undefined);
        continue;
      }
      if (entry.found === undefined || typeof entry.found.name !== "string") {
        throw new Error("Firestore batchGet returned an unreadable document");
      }
      documents.set(entry.found.name, {
        fields: entry.found.fields,
        updateTime: entry.found.updateTime,
      });
    }
    for (const name of names) {
      if (!documents.has(name)) {
        throw new Error("Firestore batchGet omitted a requested document");
      }
    }
    return documents;
  }

  // Returns `committed: false` ONLY for an outcome Firestore states did not
  // happen.
  //
  // The distinction matters more than it looks. Returning false makes the
  // caller begin a fresh, non-idempotent transaction, so `false` is a claim
  // that nothing was written. ABORTED is exactly that claim: Firestore refused
  // the commit because the read set moved. A 429 or a 503, by contrast, is
  // ambiguous -- the server may well have applied the writes and failed to tell
  // us -- and treating that as "did not commit" is how a quota gets
  // double-spent or a confirmation reported as unwritten after it landed.
  // Ambiguity fails closed.
  async commitTransaction(
    transaction: string,
    writes: readonly unknown[],
  ): Promise<FirestoreCommitOutcome> {
    const response = await this.#fetch(`${this.documentsBaseUrl}:commit`, {
      body: JSON.stringify({ transaction, writes }),
      headers: { ...(await this.headers()), "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
    if (response.ok) {
      return { committed: true, transformResults: await readTransformResults(response) };
    }
    if (response.status === 409) {
      // Decoded, not searched for. A substring test would also match the word
      // ABORTED inside a message, inside an echoed resource name, or inside a
      // proxy's HTML error page -- none of which are statements about the
      // write. Observed shape, verbatim from the emulator:
      //   {"error":{"code":409,"message":"Transaction lock timeout.","status":"ABORTED"}}
      const detail = await response.text().catch(() => "");
      if (firestoreErrorIs(409, detail, "ABORTED")) return { committed: false };
      throw new Error("Firestore transactional commit returned an unrecognised conflict");
    }
    throw new Error(`Firestore transactional commit failed: ${response.status}`);
  }

  async rollback(transaction: string): Promise<void> {
    const response = await this.#fetch(`${this.documentsBaseUrl}:rollback`, {
      body: JSON.stringify({ transaction }),
      headers: { ...(await this.headers()), "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
    // A rollback that fails changes nothing: the transaction expires on its
    // own and no write was ever committed under it.
    void response;
  }

  // Compare-and-swap without a transaction.
  //
  // Every write carries a `currentDocument.updateTime` precondition, so the
  // swap is decided by the single-document write path rather than by
  // transaction isolation. That matters because isolation is a cross-document
  // guarantee this service cannot verify from outside, whereas the
  // precondition is observable: a stale base version is refused outright.
  async commitConditional(writes: readonly unknown[]): Promise<FirestoreConditionalOutcome> {
    const response = await this.#fetch(`${this.documentsBaseUrl}:commit`, {
      body: JSON.stringify({ writes }),
      headers: { ...(await this.headers()), "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
    if (response.ok) {
      return "committed";
    }
    if (response.status === 400) {
      const detail = await response.text().catch(() => "");
      if (firestoreErrorIs(400, detail, "FAILED_PRECONDITION")) {
        return "precondition-failed";
      }
      throw new Error("Firestore conditional commit rejected the request");
    }
    throw new Error(`Firestore conditional commit failed: ${response.status}`);
  }

  async commit(writes: readonly unknown[]): Promise<{
    readonly writeResults: readonly { transformResults?: readonly FirestoreValue[] }[];
  }> {
    const response = await this.#fetch(`${this.documentsBaseUrl}:commit`, {
      body: JSON.stringify({ writes }),
      headers: { ...(await this.headers()), "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Firestore commit failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      writeResults?: readonly { transformResults?: readonly FirestoreValue[] }[];
    };
    return { writeResults: body.writeResults ?? [] };
  }

  async #accessToken(): Promise<string> {
    const now = Date.now();
    if (this.#token && this.#token.expiresAt > now + 60_000) {
      return this.#token.accessToken;
    }

    const response = await this.#fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    if (!response.ok) {
      throw new Error(`metadata token request failed: ${response.status}`);
    }

    const token = (await response.json()) as { access_token: string; expires_in: number };
    this.#token = { accessToken: token.access_token, expiresAt: now + token.expires_in * 1000 };
    return token.access_token;
  }
}

async function readTransformResults(
  response: Response,
): Promise<readonly (readonly FirestoreValue[])[]> {
  // A commit whose result cannot be read is a commit whose effect cannot be
  // checked. That is not treated as success-with-unknown-effect; the caller
  // needs the transform values to enforce its bound, so an unreadable body is
  // surfaced as an error rather than silently returning an empty list.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Firestore commit returned an unreadable body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Firestore commit returned an unreadable body");
  }
  const writeResults = (body as { writeResults?: unknown }).writeResults;
  if (writeResults === undefined) {
    return [];
  }
  if (!Array.isArray(writeResults)) {
    throw new Error("Firestore commit returned unreadable write results");
  }
  return writeResults.map((result) => {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("Firestore commit returned an unreadable write result");
    }
    const transforms = (result as { transformResults?: unknown }).transformResults;
    if (transforms === undefined) {
      return [];
    }
    if (!Array.isArray(transforms)) {
      throw new Error("Firestore commit returned unreadable transform results");
    }
    return transforms as readonly FirestoreValue[];
  });
}

export function readString(value: FirestoreValue | undefined): string {
  if (!value) {
    return "";
  }
  if ("stringValue" in value) {
    return value.stringValue;
  }
  if ("timestampValue" in value) {
    return value.timestampValue;
  }
  return value.integerValue;
}

export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll("%28", "(").replaceAll("%29", ")");
}
