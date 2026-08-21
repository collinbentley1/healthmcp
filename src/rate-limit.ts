export type RateLimitDecision = {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
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
    const cutoff = now - windowMs;
    const retained = (this.#events.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

    if (retained.length >= limit) {
      const oldest = retained[0] ?? now;
      this.#store(key, retained);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      };
    }

    retained.push(now);
    this.#store(key, retained);
    return { allowed: true };
  }

  #store(key: string, timestamps: number[]): void {
    this.#events.delete(key);
    if (this.#events.size >= this.#maxKeys) {
      const oldestKey = this.#events.keys().next().value;
      if (oldestKey !== undefined) {
        this.#events.delete(oldestKey);
      }
    }
    this.#events.set(key, timestamps);
  }
}
