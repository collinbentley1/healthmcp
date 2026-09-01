import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "./config.ts";
import { FirestoreClient, type FirestoreDocument, type FirestoreValue, readString } from "./firestore.ts";

export type { FetchLike } from "./firestore.ts";

// A submission is a claim, not a membership. It stays `pending` until the
// address is proven to belong to whoever typed it, and it expires on its own if
// that proof never arrives, so an unverified claim can never quietly age into
// something the product treats as a subscriber.
export type WaitlistStatus = "pending" | "confirmed";

export type WaitlistEntry = {
  readonly clientHash: string;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly email: string;
  readonly emailHash: string;
  readonly expiresAt: string;
  readonly source: string;
  readonly status: WaitlistStatus;
  readonly userAgentHash: string;
};

// The only creation verb the store exposes. There is deliberately no public
// read-by-email: a lookup that answers "is this address here?" is the
// enumeration oracle itself, and removing it removes the oracle rather than
// papering over it. The 409/EEXIST that distinguishes the two cases is decided
// by the storage engine in one round trip, so there is no window between the
// check and the write for a concurrent request to slip through.
export type WaitlistCreateOutcome = "created" | "duplicate";

export type WaitlistStore = {
  create(entry: WaitlistEntry): Promise<WaitlistCreateOutcome>;
};

export type WaitlistSubmission = {
  readonly clientId: string;
  readonly email: string;
  readonly source?: string | undefined;
  readonly userAgent?: string | undefined;
};

export type WaitlistResult =
  | { readonly ok: true; readonly outcome: WaitlistCreateOutcome }
  | { readonly ok: false; readonly error: string; readonly status: number };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PENDING_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function submitWaitlist(
  store: WaitlistStore,
  submission: WaitlistSubmission,
  now = new Date(),
): Promise<WaitlistResult> {
  const email = normalizeEmail(submission.email);

  if (!isValidEmail(email)) {
    return { ok: false, error: "Enter a valid email address.", status: 400 };
  }

  const entry: WaitlistEntry = {
    clientHash: sha256(submission.clientId || "unknown"),
    confirmedAt: null,
    createdAt: now.toISOString(),
    email,
    emailHash: sha256(email),
    expiresAt: new Date(now.getTime() + PENDING_TTL_SECONDS * 1_000).toISOString(),
    source: sanitizeSource(submission.source),
    status: "pending",
    userAgentHash: sha256(submission.userAgent || "unknown"),
  };

  // Both branches perform exactly one create attempt, so the caller cannot tell
  // them apart by work done, and the outcome never leaves this process.
  return { ok: true, outcome: await store.create(entry) };
}

export class MemoryWaitlistStore implements WaitlistStore {
  readonly #entries = new Map<string, WaitlistEntry>();

  async create(entry: WaitlistEntry): Promise<WaitlistCreateOutcome> {
    if (this.#entries.has(entry.emailHash)) {
      return "duplicate";
    }
    this.#entries.set(entry.emailHash, entry);
    return "created";
  }

  // Test-only inspection. Never reachable from a request path.
  peek(emailHash: string): WaitlistEntry | undefined {
    return this.#entries.get(emailHash);
  }

  get size(): number {
    return this.#entries.size;
  }
}

export class FileWaitlistStore implements WaitlistStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async create(entry: WaitlistEntry): Promise<WaitlistCreateOutcome> {
    const filePath = this.#filePath(entry.emailHash);
    await mkdir(dirname(filePath), { recursive: true });
    try {
      // `wx` is the atomic half of this: the kernel decides, not a prior read.
      await writeFile(filePath, `${JSON.stringify(entry, null, 2)}\n`, { flag: "wx" });
      return "created";
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        return "duplicate";
      }
      throw error;
    }
  }

  async read(emailHash: string): Promise<WaitlistEntry | undefined> {
    try {
      return JSON.parse(await readFile(this.#filePath(emailHash), "utf8")) as WaitlistEntry;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  #filePath(emailHash: string): string {
    return join(this.#directory, "waitlist", `${emailHash}.json`);
  }
}

export class FirestoreWaitlistStore implements WaitlistStore {
  readonly #client: FirestoreClient;
  readonly #collection: string;

  constructor(options: { client: FirestoreClient; collection: string }) {
    this.#client = options.client;
    this.#collection = options.collection;
  }

  async create(entry: WaitlistEntry): Promise<WaitlistCreateOutcome> {
    return await this.#client.create(this.#collection, entry.emailHash, toFirestoreDocument(entry));
  }

  async read(emailHash: string): Promise<WaitlistEntry | undefined> {
    const document = await this.#client.get(this.#collection, emailHash);
    return document ? fromFirestoreDocument(document) : undefined;
  }
}

export function createWaitlistStore(config: RuntimeConfig, client?: FirestoreClient): WaitlistStore {
  if (config.waitlistBackend === "memory") {
    return new MemoryWaitlistStore();
  }

  if (config.waitlistBackend === "firestore") {
    if (!config.firestoreProjectId) {
      throw new Error("FIRESTORE_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required when WAITLIST_BACKEND=firestore.");
    }

    return new FirestoreWaitlistStore({
      client: client ??
        new FirestoreClient({
          databaseId: config.firestoreDatabaseId,
          projectId: config.firestoreProjectId,
        }),
      collection: config.firestoreCollection,
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

function toFirestoreDocument(entry: WaitlistEntry): FirestoreDocument {
  const fields: Record<string, FirestoreValue> = {
    clientHash: { stringValue: entry.clientHash },
    createdAt: { timestampValue: entry.createdAt },
    email: { stringValue: entry.email },
    emailHash: { stringValue: entry.emailHash },
    expiresAt: { timestampValue: entry.expiresAt },
    source: { stringValue: entry.source },
    status: { stringValue: entry.status },
    userAgentHash: { stringValue: entry.userAgentHash },
  };
  if (entry.confirmedAt !== null) {
    fields.confirmedAt = { timestampValue: entry.confirmedAt };
  }
  return { fields };
}

function fromFirestoreDocument(document: FirestoreDocument): WaitlistEntry {
  const fields = document.fields ?? {};
  const status = readString(fields.status);
  const confirmedAt = readString(fields.confirmedAt);

  return {
    clientHash: readString(fields.clientHash),
    confirmedAt: confirmedAt || null,
    createdAt: readString(fields.createdAt),
    email: readString(fields.email),
    emailHash: readString(fields.emailHash),
    expiresAt: readString(fields.expiresAt),
    source: readString(fields.source),
    status: status === "confirmed" ? "confirmed" : "pending",
    userAgentHash: readString(fields.userAgentHash),
  };
}
