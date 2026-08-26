import { describe, expect, test } from "bun:test";
import { InMemoryRateLimiter } from "../src/rate-limit.ts";

describe("InMemoryRateLimiter", () => {
  test("bounds attacker-controlled key growth", () => {
    const limiter = new InMemoryRateLimiter(2);

    expect(limiter.check("first", 5, 60_000, 1).allowed).toBeTrue();
    expect(limiter.check("second", 5, 60_000, 2).allowed).toBeTrue();
    expect(limiter.check("third", 5, 60_000, 3).allowed).toBeTrue();
    expect(limiter.trackedKeyCount).toBe(2);
  });

  test("retains active limits while refreshing key recency", () => {
    const limiter = new InMemoryRateLimiter(2);

    expect(limiter.check("active", 1, 60_000, 1).allowed).toBeTrue();
    expect(limiter.check("active", 1, 60_000, 2).allowed).toBeFalse();
    expect(limiter.check("other", 1, 60_000, 3).allowed).toBeTrue();
    expect(limiter.check("new", 1, 60_000, 4).allowed).toBeTrue();
    expect(limiter.trackedKeyCount).toBe(2);
  });

  test("does not charge unrelated budgets when one rule rejects the request", () => {
    const limiter = new InMemoryRateLimiter();
    const rules = (client: string) => [
      { key: `client:${client}`, limit: 1, windowMs: 60_000 },
      { key: "global", limit: 2, windowMs: 60_000 },
    ];

    expect(limiter.checkMany(rules("first"), 1).allowed).toBeTrue();
    expect(limiter.checkMany(rules("first"), 2).allowed).toBeFalse();
    expect(limiter.checkMany(rules("second"), 3).allowed).toBeTrue();
    expect(limiter.checkMany(rules("third"), 4).allowed).toBeFalse();
  });
});
