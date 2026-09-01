import type { FirestoreClient, FirestoreValue } from "./firestore.ts";

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
const MAX_QUOTA_TRANSACTION_ATTEMPTS = 5;

// An ABORTED arrives from Firestore as a LOCK TIMEOUT, not as a cheap
// optimistic rejection -- observed verbatim against the emulator:
//   409 {"error":{"code":409,"message":"Transaction lock timeout.","status":"ABORTED"}}
// Retries therefore cost real wall-clock time, so a bounded attempt count is
// not by itself a bound on latency. Without a deadline, contention becomes
// both a latency amplifier and a timing channel: how long a rejection takes
// would tell a caller how contended its own bucket is.
const MAX_QUOTA_WALL_CLOCK_MS = 5_000;

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
  readonly #deadlineMs: number;
  readonly #monotonicNow: () => number;

  constructor(options: {
    client: FirestoreClient;
    collection: string;
    deadlineMs?: number;
    monotonicNow?: () => number;
  }) {
    this.#client = options.client;
    this.#collection = options.collection;
    this.#deadlineMs = options.deadlineMs ?? MAX_QUOTA_WALL_CLOCK_MS;
    // Monotonic: a wall clock that steps backwards would extend the budget.
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async consume(rules: readonly QuotaRule[], now: Date): Promise<QuotaDecision> {
    assertRules(rules);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("waitlist quota requires a valid observation time");
    }

    // Check every bucket, THEN advance them -- and only if all of them allow it.
    //
    // The previous shape incremented first and judged afterwards, so a request
    // that was always going to be refused still spent the shared budget on its
    // way to being refused. Flooding one narrow bucket (a single address, say)
    // therefore drained the global one and denied service to everybody else.
    // A read-judge-write transaction removes that: a refusal costs the narrow
    // bucket nothing and the global bucket nothing.
    //
    // Two independent mechanisms, because they protect different things.
    //
    // The transaction provides FAIRNESS: a refusal is decided before any write,
    // so a refused request spends no budget and one flooded bucket cannot drain
    // a shared one.
    //
    // The increment transform's RETURN VALUE provides the SAFETY BOUND. The
    // commit reports the post-increment count for every counter it advanced
    // (verified against the Firestore emulator: successive commits returned
    // transformResults of 1, then 2, then 3). Checking that value is what caps
    // admissions, and it holds whatever the isolation level turns out to be:
    // if two instances somehow both passed the read-judge with one slot left,
    // their increments still return distinct values and the one that lands
    // above the limit is refused. Safety therefore does not rest on any
    // cross-document isolation guarantee, which is not a property this service
    // can observe from outside.
    const names = rules.map((rule) => this.#documentName(rule.key, windowIndex(nowMs, rule.windowSeconds)));
    const startedAt = this.#monotonicNow();
    for (let attempt = 1; attempt <= MAX_QUOTA_TRANSACTION_ATTEMPTS; attempt += 1) {
      // Checked before each attempt, including the first, so a caller that is
      // already out of budget never opens a transaction it cannot finish.
      if (attempt > 1 && this.#monotonicNow() - startedAt >= this.#deadlineMs) {
        throw new Error("Firestore waitlist quota exceeded its decision deadline");
      }
      const transaction = await this.#client.beginTransaction();
      let decided: QuotaDecision | undefined;
      try {
        const documents = await this.#client.batchGet(names, transaction);
        let allowed = true;
        let retryAfterSeconds = 0;
        rules.forEach((rule, position) => {
          const document = documents.get(names[position]!);
          const raw = document?.fields?.count;
          const current = raw === undefined
            ? 0
            : "integerValue" in raw
            ? Number(raw.integerValue)
            : Number.NaN;
          // A counter that cannot be read is not a counter that reads zero.
          if (!Number.isSafeInteger(current) || current < 0) {
            throw new Error("Firestore waitlist quota read an unusable counter");
          }
          if (current + 1 > rule.limit) {
            allowed = false;
            retryAfterSeconds = Math.max(retryAfterSeconds, retryAfter(nowMs, rule.windowSeconds));
          }
        });
        if (!allowed) {
          decided = { allowed: false, retryAfterSeconds };
        } else {
          const writes: unknown[] = rules.map((rule, position) => {
            const index = windowIndex(nowMs, rule.windowSeconds);
            return {
              update: {
                fields: {
                  expiresAt: {
                    timestampValue: new Date((index + 2) * rule.windowSeconds * 1_000)
                      .toISOString(),
                  },
                },
                name: names[position]!,
              },
              updateMask: { fieldPaths: ["expiresAt"] },
              updateTransforms: [{ fieldPath: "count", increment: { integerValue: "1" } }],
            };
          });
          // Self-cleaning defence in depth. The window before last can no
          // longer be consulted, so every allowed request retires one bucket.
          // The authoritative bound is the Firestore TTL policy on `expiresAt`,
          // which also reaps buckets that never receive another request.
          for (const rule of rules) {
            writes.push({
              delete: this.#documentName(rule.key, windowIndex(nowMs, rule.windowSeconds) - 2),
            });
          }
          const outcome = await this.#client.commitTransaction(transaction, writes);
          if (outcome.committed) {
            // The counters actually moved. Judge the authoritative post-
            // increment values rather than the pre-read ones.
            const overflow = firstOverflow(rules, outcome.transformResults, nowMs);
            if (overflow !== undefined) {
              return { allowed: false, retryAfterSeconds: overflow };
            }
            return { allowed: true, retryAfterSeconds: 0 };
          }
          // Contention: somebody else moved a counter this decision was based
          // on, so the decision is void and the whole thing is retried.
          continue;
        }
      } catch (error) {
        await this.#client.rollback(transaction);
        throw error;
      }
      // A refusal writes nothing at all, which is the entire point.
      await this.#client.rollback(transaction);
      return decided;
    }
    // Retries exhausted under sustained contention. Fail closed: an instance
    // that never got a clean read has no idea what the budget is.
    throw new Error("Firestore waitlist quota could not commit a decision");
  }

  #documentName(key: string, index: number): string {
    return this.#client.documentName(this.#collection, `${key.replaceAll(":", "__")}--${index}`);
  }
}

// The authoritative cap. `results` are the post-increment counts Firestore
// returned, positionally aligned with the increment writes, which are the
// first `rules.length` writes in the commit.
//
// An unreadable result is not treated as "within budget": a commit whose
// effect cannot be checked has to fail closed, because the increment has
// already landed and nothing else will catch an overflow.
function firstOverflow(
  rules: readonly QuotaRule[],
  results: readonly (readonly FirestoreValue[])[],
  nowMs: number,
): number | undefined {
  if (results.length < rules.length) {
    throw new Error("Firestore waitlist quota commit returned too few transform results");
  }
  let retryAfterSeconds: number | undefined;
  rules.forEach((rule, position) => {
    const transformed = results[position];
    if (!Array.isArray(transformed) || transformed.length !== 1) {
      throw new Error("Firestore waitlist quota commit returned an unusable transform result");
    }
    const value = transformed[0];
    if (value === undefined || !("integerValue" in value)) {
      throw new Error("Firestore waitlist quota commit returned a non-integer counter");
    }
    const count = Number(value.integerValue);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error("Firestore waitlist quota commit returned an out-of-range counter");
    }
    if (count > rule.limit) {
      retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, retryAfter(nowMs, rule.windowSeconds));
    }
  });
  return retryAfterSeconds;
}

// Single-process stand-in with identical semantics, for local runs and tests.
// It is never the authoritative limiter for a deployed service.
export class MemoryWaitlistQuota implements WaitlistQuota {
  readonly #counters = new Map<string, number>();

  async consume(rules: readonly QuotaRule[], now: Date): Promise<QuotaDecision> {
    assertRules(rules);
    const nowMs = now.getTime();
    // Same semantics as the Firestore path: judge every bucket first, and spend
    // nothing at all if any of them refuses. A refusal must not cost budget, or
    // one narrow bucket can be flooded to drain a shared one.
    let allowed = true;
    let retryAfterSeconds = 0;
    for (const rule of rules) {
      const index = windowIndex(nowMs, rule.windowSeconds);
      const current = this.#counters.get(`${rule.key}--${index}`) ?? 0;
      if (current + 1 > rule.limit) {
        allowed = false;
        retryAfterSeconds = Math.max(retryAfterSeconds, retryAfter(nowMs, rule.windowSeconds));
      }
    }
    if (!allowed) return { allowed: false, retryAfterSeconds };
    for (const rule of rules) {
      const index = windowIndex(nowMs, rule.windowSeconds);
      this.#counters.set(`${rule.key}--${index}`, (this.#counters.get(`${rule.key}--${index}`) ?? 0) + 1);
      this.#counters.delete(`${rule.key}--${index - 2}`);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  get trackedBucketCount(): number {
    return this.#counters.size;
  }
}
