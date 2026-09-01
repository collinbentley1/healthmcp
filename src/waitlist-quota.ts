import type { FirestoreClient } from "./firestore.ts";

// The authoritative abuse control. It has to be authoritative because the
// in-process limiter never was: Cloud Run runs many instances, each with its
// own Map, so "60 requests per minute" meant "60 per minute per instance" and
// scaled linearly with traffic. Anything that decides whether a request is
// abusive therefore lives in Firestore, shared by every instance.

export type QuotaRule = {
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
};

export type QuotaDecision = {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
};

export interface WaitlistQuota {
  consume(rules: readonly QuotaRule[], now: Date): Promise<QuotaDecision>;
}

const MAX_QUOTA_RULES = 8;

function assertRules(rules: readonly QuotaRule[]): void {
  if (rules.length < 1 || rules.length > MAX_QUOTA_RULES) {
    throw new Error("waitlist quota requires between one and eight rules");
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    if (
      !rule.key ||
      !/^[a-z0-9:_-]{1,120}$/.test(rule.key) ||
      seen.has(rule.key) ||
      !Number.isSafeInteger(rule.limit) ||
      rule.limit < 1 ||
      !Number.isSafeInteger(rule.windowSeconds) ||
      rule.windowSeconds < 1
    ) {
      throw new Error("waitlist quota rules require unique safe keys and positive integer bounds");
    }
    seen.add(rule.key);
  }
}

function windowIndex(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / (windowSeconds * 1_000));
}

function retryAfter(nowMs: number, windowSeconds: number): number {
  const index = windowIndex(nowMs, windowSeconds);
  const endsAtMs = (index + 1) * windowSeconds * 1_000;
  return Math.max(1, Math.ceil((endsAtMs - nowMs) / 1_000));
}

// Fixed windows, one document per (rule, window). The document id is derived,
// so an instance never has to discover which bucket it is in, and the bucket
// two windows back is deleted in the same atomic commit that increments the
// current one. That keeps the collection bounded without depending on a
// Firestore TTL policy that this service cannot provision for itself.
export class FirestoreWaitlistQuota implements WaitlistQuota {
  readonly #client: FirestoreClient;
  readonly #collection: string;

  constructor(options: { client: FirestoreClient; collection: string }) {
    this.#client = options.client;
    this.#collection = options.collection;
  }

  async consume(rules: readonly QuotaRule[], now: Date): Promise<QuotaDecision> {
    assertRules(rules);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("waitlist quota requires a valid observation time");
    }

    // One commit. Firestore applies every write in it atomically, and an
    // `increment` transform returns the value it produced, so the counter is
    // read and advanced in the same indivisible step. Two instances racing on
    // the same bucket therefore get two different numbers, never the same one.
    const writes: unknown[] = rules.map((rule) => {
      const index = windowIndex(nowMs, rule.windowSeconds);
      return {
        update: {
          fields: {
            expiresAt: {
              timestampValue: new Date((index + 2) * rule.windowSeconds * 1_000).toISOString(),
            },
          },
          name: this.#documentName(rule.key, index),
        },
        updateMask: { fieldPaths: ["expiresAt"] },
        updateTransforms: [{ fieldPath: "count", increment: { integerValue: "1" } }],
      };
    });
    // Self-cleaning. The window before last can no longer be consulted by any
    // instance, so every request retires exactly one bucket and the collection
    // stays bounded without depending on a TTL policy this service cannot
    // provision for itself.
    for (const rule of rules) {
      writes.push({
        delete: this.#documentName(rule.key, windowIndex(nowMs, rule.windowSeconds) - 2),
      });
    }

    const { writeResults } = await this.#client.commit(writes);
    // A commit that does not report a counter for every rule has an unknown
    // outcome, and an unknown outcome cannot authorize a request.
    if (writeResults.length !== writes.length) {
      throw new Error("Firestore waitlist quota commit returned an incomplete result set");
    }

    let allowed = true;
    let retryAfterSeconds = 0;
    rules.forEach((rule, position) => {
      const transform = writeResults[position]?.transformResults?.[0];
      const raw = transform && "integerValue" in transform ? transform.integerValue : undefined;
      const count = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error("Firestore waitlist quota commit returned an unusable counter");
      }
      if (count > rule.limit) {
        allowed = false;
        retryAfterSeconds = Math.max(retryAfterSeconds, retryAfter(nowMs, rule.windowSeconds));
      }
    });

    return allowed ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds };
  }

  #documentName(key: string, index: number): string {
    return this.#client.documentName(this.#collection, `${key.replaceAll(":", "__")}--${index}`);
  }
}

// Single-process stand-in with identical semantics, for local runs and tests.
// It is never the authoritative limiter for a deployed service.
export class MemoryWaitlistQuota implements WaitlistQuota {
  readonly #counters = new Map<string, number>();

  async consume(rules: readonly QuotaRule[], now: Date): Promise<QuotaDecision> {
    assertRules(rules);
    const nowMs = now.getTime();
    let allowed = true;
    let retryAfterSeconds = 0;
    for (const rule of rules) {
      const index = windowIndex(nowMs, rule.windowSeconds);
      const id = `${rule.key}--${index}`;
      const count = (this.#counters.get(id) ?? 0) + 1;
      this.#counters.set(id, count);
      this.#counters.delete(`${rule.key}--${index - 2}`);
      if (count > rule.limit) {
        allowed = false;
        retryAfterSeconds = Math.max(retryAfterSeconds, retryAfter(nowMs, rule.windowSeconds));
      }
    }
    return allowed ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds };
  }

  get trackedBucketCount(): number {
    return this.#counters.size;
  }
}
