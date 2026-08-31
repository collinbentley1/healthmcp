export type RateLimitDecision = {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
};

export type RateLimitRule = {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
};

export class InMemoryRateLimiter {
  readonly #events = new Map<string, number[]>();
  readonly #maxKeys: number;

  constructor(maxKeys = 4_096) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
      throw new Error("maxKeys must be a positive safe integer");
    }

    this.#maxKeys = maxKeys;
  }

  get trackedKeyCount(): number {
    return this.#events.size;
  }

  check(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitDecision {
    return this.checkMany([{ key, limit, windowMs }], now);
  }

  checkMany(rules: readonly RateLimitRule[], now = Date.now()): RateLimitDecision {
    if (rules.length === 0) {
      throw new Error("at least one rate-limit rule is required");
    }

    const seenKeys = new Set<string>();
    const evaluations = rules.map((rule) => {
      if (
        !rule.key ||
        seenKeys.has(rule.key) ||
        !Number.isSafeInteger(rule.limit) ||
        rule.limit < 1 ||
        !Number.isSafeInteger(rule.windowMs) ||
        rule.windowMs < 1
      ) {
        throw new Error("rate-limit rules require unique nonempty keys and positive safe-integer bounds");
      }
      seenKeys.add(rule.key);

      const cutoff = now - rule.windowMs;
      const retained = (this.#events.get(rule.key) ?? []).filter(
        (timestamp) => timestamp > cutoff,
      );
      return { retained, rule };
    });
    const denied = evaluations.filter(({ retained, rule }) => retained.length >= rule.limit);

    if (denied.length > 0) {
      for (const { retained, rule } of evaluations) {
        this.#store(rule.key, retained);
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          ...denied.map(({ retained, rule }) => {
            const oldest = retained[0] ?? now;
            return Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
          }),
        ),
      };
    }

    for (const { retained, rule } of evaluations) {
      retained.push(now);
      this.#store(rule.key, retained);
    }
    return { allowed: true };
  }

  #store(key: string, timestamps: number[]): void {
    this.#events.delete(key);
    if (timestamps.length === 0) {
      return;
    }
    if (this.#events.size >= this.#maxKeys) {
      const oldestKey = this.#events.keys().next().value;
      if (oldestKey !== undefined) {
        this.#events.delete(oldestKey);
      }
    }
    this.#events.set(key, timestamps);
  }
}
