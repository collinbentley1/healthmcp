export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FirestoreCreateOutcome = "created" | "duplicate";

export type FirestoreValue =
  | { readonly integerValue: string }
  | { readonly stringValue: string }
  | { readonly timestampValue: string };

export type FirestoreDocument = {
  readonly fields?: Record<string, FirestoreValue>;
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
