export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FirestoreCreateOutcome = "created" | "duplicate";

export type FirestoreValue =
  | { readonly integerValue: string }
  | { readonly stringValue: string }
  | { readonly timestampValue: string };

export type FirestoreDocument = {
  readonly fields?: Record<string, FirestoreValue>;
  readonly name?: string;
};

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
      return "duplicate";
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
      readonly found?: { readonly fields?: Record<string, FirestoreValue>; readonly name: string };
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
      documents.set(entry.found.name, { fields: entry.found.fields });
    }
    for (const name of names) {
      if (!documents.has(name)) {
        throw new Error("Firestore batchGet omitted a requested document");
      }
    }
    return documents;
  }

  // Returns false only for a contention abort, which the caller may retry.
  // Every other failure is a real failure and throws.
  async commitTransaction(transaction: string, writes: readonly unknown[]): Promise<boolean> {
    const response = await this.#fetch(`${this.documentsBaseUrl}:commit`, {
      body: JSON.stringify({ transaction, writes }),
      headers: { ...(await this.headers()), "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    });
    if (response.ok) return true;
    if (response.status === 409 || response.status === 429 || response.status === 503) {
      return false;
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
