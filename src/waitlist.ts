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
  readonly confirmedSubject: string | null;
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

export type WaitlistConfirmOutcome = "confirmed" | "already-confirmed" | "absent" | "expired";

export type WaitlistStore = {
  create(entry: WaitlistEntry): Promise<WaitlistCreateOutcome>;
  // Promotes exactly one pending entry to confirmed, or reports why it could
  // not. The transition is single-use: a second call with the same proof gets
  // "already-confirmed", never a second promotion, so a replayed token cannot
  // reset an entry's state or extend its life.
  confirm(
    emailHash: string,
    subject: string,
    nowMs: number,
  ): Promise<WaitlistConfirmOutcome>;
  // Whether a live pending entry exists for this hash.
  //
  // Deliberately a boolean and not the entry. The only caller is the challenge
  // dispatcher, which needs to know whether sending mail to this address is
  // something the address already asked for -- and nothing else. Returning the
  // record would put the stored address, its creation time, and its client
  // hash within reach of a request path that has no use for them.
  pendingExists(emailHash: string, nowMs: number): Promise<boolean>;
};

// One judgement of "live and pending", shared by every backend so they cannot
// disagree. A record that does not validate is not pending: a corrupt entry
// must not become a reason to send mail.
function entryIsPending(stored: unknown, emailHash: string, nowMs: number): boolean {
  let entry;
  try {
    entry = waitlistEntryFromUnknown(stored, emailHash);
  } catch {
    return false;
  }
  return entry.status === "pending" && Date.parse(entry.expiresAt) > nowMs;
}

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
// Far enough out that the TTL policy never reaps a confirmed member, while
// leaving the field present so the policy still has something to read.
export // Bounded so a hostile racer cannot hold a request open indefinitely.
const MAX_CONFIRM_ATTEMPTS = 5;

const CONFIRMED_EXPIRES_AT = "9999-12-31T23:59:59.000Z";

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
    confirmedSubject: null,
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

// One strict validator for every persisted record, used by every path that is
// about to act on one.
//
// The failure this closes is subtle and fails OPEN: an expiry check written as
// `Date.parse(entry.expiresAt) <= nowMs` is FALSE when the parse yields NaN, so
// a record with a missing, empty, or corrupt expiry was treated as unexpired
// and promoted. A legacy row, a partial write, or a hand-edited document was
// therefore a path to confirmation. Nothing here coerces: a record that is not
// internally consistent is refused, and the caller mutates nothing.
export function waitlistEntryFromUnknown(
  value: unknown,
  expectedEmailHash: string,
): WaitlistEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("waitlist record is not an object");
  }
  const source = value as Record<string, unknown>;
  const text = (field: string, max = 512): string => {
    const raw = source[field];
    if (typeof raw !== "string" || raw.length === 0 || raw.length > max) {
      throw new Error(`waitlist record field ${field} is malformed`);
    }
    return raw;
  };
  const instant = (field: string): string => {
    const raw = text(field, 64);
    const parsed = Date.parse(raw);
    // Canonical, and above all FINITE: an unparseable timestamp must not become
    // a comparison that silently succeeds.
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
      throw new Error(`waitlist record field ${field} is not a canonical instant`);
    }
    return raw;
  };
  const nullableText = (field: string, max = 512): string | null => {
    const raw = source[field];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > max) {
      throw new Error(`waitlist record field ${field} is malformed`);
    }
    return raw;
  };

  const status = source.status;
  if (status !== "pending" && status !== "confirmed") {
    // Never coerce an unknown state to pending: an unrecognised status is a
    // record this code does not understand, not a claim awaiting confirmation.
    throw new Error("waitlist record status is not a recognised state");
  }

  const email = text("email", 254);
  if (email !== normalizeEmail(email)) {
    throw new Error("waitlist record email is not normalised");
  }
  const emailHash = text("emailHash", 64);
  // The record must be about the address it claims, and must be the record the
  // caller asked for. Either mismatch means the document identity and its
  // contents disagree, and acting on it would confirm somebody else's address.
  if (emailHash !== sha256(email)) {
    throw new Error("waitlist record hash does not match its email");
  }
  if (emailHash !== expectedEmailHash) {
    throw new Error("waitlist record does not belong to the requested address");
  }

  const confirmedAt = nullableText("confirmedAt", 64);
  const confirmedSubject = nullableText("confirmedSubject", 128);
  if (status === "pending" && (confirmedAt !== null || confirmedSubject !== null)) {
    throw new Error("waitlist record is pending but carries confirmation fields");
  }
  if (status === "confirmed" && (confirmedAt === null || confirmedSubject === null)) {
    throw new Error("waitlist record is confirmed but carries no confirmation");
  }
  if (confirmedAt !== null) instant("confirmedAt");

  return {
    clientHash: text("clientHash", 64),
    confirmedAt,
    confirmedSubject,
    createdAt: instant("createdAt"),
    email,
    emailHash,
    expiresAt: instant("expiresAt"),
    source: text("source", 60),
    status,
    userAgentHash: text("userAgentHash", 64),
  };
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

  async confirm(
    emailHash: string,
    subject: string,
    nowMs: number,
  ): Promise<WaitlistConfirmOutcome> {
    const stored = this.#entries.get(emailHash);
    if (stored === undefined) return "absent";
    // Validated before it is acted on, so a corrupt expiry cannot become a
    // comparison that quietly succeeds.
    const entry = waitlistEntryFromUnknown(stored, emailHash);
    if (entry.status === "confirmed") return "already-confirmed";
    if (Date.parse(entry.expiresAt) <= nowMs) return "expired";
    this.#entries.set(emailHash, {
      ...entry,
      confirmedAt: new Date(nowMs).toISOString(),
      confirmedSubject: subject,
      // Confirmation clears the expiry: a verified member is not a claim that
      // ages out. The TTL policy only reaps documents whose expiresAt is in the
      // past, so a far-future value keeps a confirmed entry indefinitely while
      // leaving the field present for the policy to read.
      expiresAt: CONFIRMED_EXPIRES_AT,
      status: "confirmed",
    });
    return "confirmed";
  }

  async pendingExists(emailHash: string, nowMs: number): Promise<boolean> {
    return entryIsPending(this.#entries.get(emailHash), emailHash, nowMs);
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

  // Deliberately unsupported.
  //
  // A durable single-use transition needs a compare-and-swap, and this backend
  // has none: read-then-write lets two concurrent confirmations both succeed,
  // with the second subject overwriting the first. That would contradict the
  // interface, so rather than offer a promotion that is only single-use when
  // nobody races it, this refuses. Deployed services are required to run the
  // Firestore backend, which does have one.
  async confirm(): Promise<WaitlistConfirmOutcome> {
    throw new Error(
      "The file waitlist backend has no compare-and-swap and cannot confirm ownership; use WAITLIST_BACKEND=firestore.",
    );
  }

  async pendingExists(emailHash: string, nowMs: number): Promise<boolean> {
    return entryIsPending(await this.read(emailHash), emailHash, nowMs);
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

  // Single-use, enforced by a per-document compare-and-swap.
  //
  // This deliberately does NOT rely on transaction isolation. Isolation is a
  // cross-document guarantee that this service cannot observe from outside,
  // and a promotion is the one operation where being wrong hands somebody
  // else's account away. Instead the entry is read, and the promotion carries
  // the exact `updateTime` that read observed as a write precondition. If
  // anything touched the entry in between -- a second confirmation, a racing
  // subject, an administrative edit -- the stored version no longer matches
  // the required base version and Firestore refuses the write outright.
  //
  // Verified against the Firestore emulator: replaying a stale updateTime is
  // refused with FAILED_PRECONDITION and the document keeps its first value,
  // so the first confirmation wins and the second cannot clobber its subject.
  async confirm(
    emailHash: string,
    subject: string,
    nowMs: number,
  ): Promise<WaitlistConfirmOutcome> {
    const name = this.#client.documentName(this.#collection, emailHash);
    for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt += 1) {
      const document = await this.#client.get(this.#collection, emailHash);
      if (document === undefined) {
        return "absent";
      }
      // A document with no version cannot be swapped safely, and promoting it
      // unconditionally is exactly the read-then-blind-write this replaced.
      const baseVersion = document.updateTime;
      if (typeof baseVersion !== "string" || baseVersion.length === 0) {
        throw new Error("Firestore waitlist entry has no version to compare against");
      }
      const entry = waitlistEntryFromUnknown(fromFirestoreDocument(document), emailHash);
      if (entry.status === "confirmed") {
        return "already-confirmed";
      }
      if (Date.parse(entry.expiresAt) <= nowMs) {
        return "expired";
      }
      const outcome = await this.#client.commitConditional([{
        currentDocument: { updateTime: baseVersion },
        update: toFirestoreDocument({
          ...entry,
          confirmedAt: new Date(nowMs).toISOString(),
          confirmedSubject: subject,
          expiresAt: CONFIRMED_EXPIRES_AT,
          status: "confirmed",
        }, name),
        updateMask: {
          fieldPaths: ["confirmedAt", "confirmedSubject", "expiresAt", "status"],
        },
      }]);
      if (outcome === "committed") {
        return "confirmed";
      }
      // The entry moved. Re-read and re-judge; the next pass observes whatever
      // the winner wrote, which is how a second confirmation reports
      // "already-confirmed" rather than promoting twice.
    }
    // Never guess at membership state.
    throw new Error("Firestore waitlist confirmation could not commit");
  }

  async pendingExists(emailHash: string, nowMs: number): Promise<boolean> {
    const document = await this.#client.get(this.#collection, emailHash);
    if (document === undefined) return false;
    return entryIsPending(fromFirestoreDocument(document), emailHash, nowMs);
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

function toFirestoreDocument(entry: WaitlistEntry, name?: string): FirestoreDocument {
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
  if (entry.confirmedSubject !== null) {
    fields.confirmedSubject = { stringValue: entry.confirmedSubject };
  }
  return name === undefined ? { fields } : { fields, name };
}

function fromFirestoreDocument(document: FirestoreDocument): WaitlistEntry {
  const fields = document.fields ?? {};
  // Read faithfully. Mapping an unrecognised status to "pending" here would
  // hand waitlistEntryFromUnknown a record that always validates, which is
  // exactly the coercion that made a corrupt document promotable.
  const status = readString(fields.status);
  const confirmedAt = readString(fields.confirmedAt);

  return {
    clientHash: readString(fields.clientHash),
    confirmedAt: confirmedAt || null,
    confirmedSubject: readString(fields.confirmedSubject) || null,
    createdAt: readString(fields.createdAt),
    email: readString(fields.email),
    emailHash: readString(fields.emailHash),
    expiresAt: readString(fields.expiresAt),
    source: readString(fields.source),
    status: status as WaitlistStatus,
    userAgentHash: readString(fields.userAgentHash),
  };
}
