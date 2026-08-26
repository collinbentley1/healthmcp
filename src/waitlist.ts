import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "./config.ts";

export type WaitlistEntry = {
  readonly clientHash: string;
  readonly createdAt: string;
  readonly email: string;
  readonly emailHash: string;
  readonly source: string;
  readonly userAgentHash: string;
};

export type WaitlistStore = {
  get(emailHash: string): Promise<WaitlistEntry | undefined>;
  put(entry: WaitlistEntry): Promise<void>;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WaitlistSubmission = {
  readonly clientId: string;
  readonly email: string;
  readonly source?: string | undefined;
  readonly userAgent?: string | undefined;
};

export type WaitlistResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly entry: WaitlistEntry }
  | { readonly ok: false; readonly error: string; readonly status: number };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function submitWaitlist(store: WaitlistStore, submission: WaitlistSubmission, now = new Date()): Promise<WaitlistResult> {
  const email = normalizeEmail(submission.email);

  if (!isValidEmail(email)) {
    return { ok: false, error: "Enter a valid email address.", status: 400 };
  }

  const emailHash = sha256(email);
  const existing = await store.get(emailHash);
  if (existing) {
    return { ok: true, duplicate: true, entry: existing };
  }

  const entry: WaitlistEntry = {
    clientHash: sha256(submission.clientId || "unknown"),
    createdAt: now.toISOString(),
    email,
    emailHash,
    source: sanitizeSource(submission.source),
    userAgentHash: sha256(submission.userAgent || "unknown"),
  };

  await store.put(entry);
  return { ok: true, duplicate: false, entry };
}

export class MemoryWaitlistStore implements WaitlistStore {
  readonly #entries = new Map<string, WaitlistEntry>();

  async get(emailHash: string): Promise<WaitlistEntry | undefined> {
    return this.#entries.get(emailHash);
  }

  async put(entry: WaitlistEntry): Promise<void> {
    this.#entries.set(entry.emailHash, entry);
  }
}

export class FileWaitlistStore implements WaitlistStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async get(emailHash: string): Promise<WaitlistEntry | undefined> {
    const filePath = this.#filePath(emailHash);
    try {
      const entry = JSON.parse(await readFile(filePath, "utf8")) as WaitlistEntry & {
        readonly ipHash?: string;
      };
      return {
        ...entry,
        clientHash: entry.clientHash || entry.ipHash || "",
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  async put(entry: WaitlistEntry): Promise<void> {
    const filePath = this.#filePath(entry.emailHash);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(entry, null, 2)}\n`, { flag: "wx" });
  }

  #filePath(emailHash: string): string {
    return join(this.#directory, "waitlist", `${emailHash}.json`);
  }
}

export class FirestoreWaitlistStore implements WaitlistStore {
  readonly #collection: string;
  readonly #databaseId: string;
  readonly #fetch: FetchLike;
  readonly #projectId: string;
  #token: { readonly accessToken: string; readonly expiresAt: number } | undefined;

  constructor(options: { collection: string; databaseId: string; fetcher?: FetchLike; projectId: string }) {
    this.#collection = options.collection;
    this.#databaseId = options.databaseId;
    this.#fetch = options.fetcher ?? fetch;
    this.#projectId = options.projectId;
  }

  async get(emailHash: string): Promise<WaitlistEntry | undefined> {
    const response = await this.#fetch(this.#documentUrl(emailHash), {
      headers: await this.#headers(),
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Firestore waitlist read failed: ${response.status}`);
    }

    return fromFirestoreDocument(await response.json());
  }

  async put(entry: WaitlistEntry): Promise<void> {
    const response = await this.#fetch(this.#collectionUrl(entry.emailHash), {
      body: JSON.stringify(toFirestoreDocument(entry)),
      headers: {
        ...(await this.#headers()),
        "Content-Type": "application/json; charset=utf-8",
      },
      method: "POST",
    });

    if (response.status === 409) {
      return;
    }

    if (!response.ok) {
      throw new Error(`Firestore waitlist write failed: ${response.status}`);
    }
  }

  async #headers(): Promise<Record<string, string>> {
    const accessToken = await this.#accessToken();
    return { Authorization: `Bearer ${accessToken}` };
  }

  async #accessToken(): Promise<string> {
    const now = Date.now();
    if (this.#token && this.#token.expiresAt > now + 60_000) {
      return this.#token.accessToken;
    }

    const response = await this.#fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" },
    });

    if (!response.ok) {
      throw new Error(`metadata token request failed: ${response.status}`);
    }

    const token = (await response.json()) as { access_token: string; expires_in: number };
    this.#token = {
      accessToken: token.access_token,
      expiresAt: now + token.expires_in * 1000,
    };
    return token.access_token;
  }

  #documentUrl(emailHash: string): string {
    return `${this.#documentsBaseUrl()}/${encodePathSegment(this.#collection)}/${encodePathSegment(emailHash)}`;
  }

  #collectionUrl(emailHash: string): string {
    return `${this.#documentsBaseUrl()}/${encodePathSegment(this.#collection)}?documentId=${encodeURIComponent(emailHash)}`;
  }

  #documentsBaseUrl(): string {
    return `https://firestore.googleapis.com/v1/projects/${this.#projectId}/databases/${encodePathSegment(this.#databaseId)}/documents`;
  }
}

export function createWaitlistStore(config: RuntimeConfig): WaitlistStore {
  if (config.waitlistBackend === "memory") {
    return new MemoryWaitlistStore();
  }

  if (config.waitlistBackend === "firestore") {
    if (!config.firestoreProjectId) {
      throw new Error("FIRESTORE_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required when WAITLIST_BACKEND=firestore.");
    }

    return new FirestoreWaitlistStore({
      collection: config.firestoreCollection,
      databaseId: config.firestoreDatabaseId,
      projectId: config.firestoreProjectId,
    });
  }

  return new FileWaitlistStore(config.dataDir);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return email.length >= 3 && email.length <= 254 && EMAIL_PATTERN.test(email);
}

function sanitizeSource(value: string | undefined): string {
  const source = value?.trim() || "site";
  return source.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 60) || "site";
}

type FirestoreDocument = {
  readonly fields?: Record<string, FirestoreValue>;
};

type FirestoreValue =
  | { readonly integerValue: string }
  | { readonly stringValue: string }
  | { readonly timestampValue: string };

function toFirestoreDocument(entry: WaitlistEntry): FirestoreDocument {
  return {
    fields: {
      createdAt: { timestampValue: entry.createdAt },
      clientHash: { stringValue: entry.clientHash },
      email: { stringValue: entry.email },
      emailHash: { stringValue: entry.emailHash },
      source: { stringValue: entry.source },
      userAgentHash: { stringValue: entry.userAgentHash },
    },
  };
}

function fromFirestoreDocument(document: FirestoreDocument): WaitlistEntry {
  const fields = document.fields ?? {};

  return {
    clientHash: readString(fields.clientHash) || readString(fields.ipHash),
    createdAt: readString(fields.createdAt),
    email: readString(fields.email),
    emailHash: readString(fields.emailHash),
    source: readString(fields.source),
    userAgentHash: readString(fields.userAgentHash),
  };
}

function readString(value: FirestoreValue | undefined): string {
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

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll("%28", "(").replaceAll("%29", ")");
}
