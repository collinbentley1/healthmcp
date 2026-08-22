import { describe, expect, test } from "bun:test";
import {
  resolveWaitlistClient,
  type WaitlistClientIdentity,
} from "../src/waitlist-client.ts";

const secret = new Uint8Array(32).fill(11);

describe("waitlist client identity", () => {
  test("mints an authenticated, host-only browser cookie and accepts it again", () => {
    const minted = resolveWaitlistClient(
      new Request("https://medlock.ai/api/waitlist"),
      secret,
    );
    const cookie = cookiePair(minted);

    expect(minted.setCookie).toContain("Path=/api/waitlist");
    expect(minted.setCookie).toContain("HttpOnly");
    expect(minted.setCookie).toContain("SameSite=Strict");
    expect(minted.setCookie).toContain("Secure");
    expect(minted.setCookie).not.toContain("Domain=");

    const accepted = resolveWaitlistClient(
      new Request("https://medlock.ai/api/waitlist", {
        headers: { Cookie: `unrelated=value; ${cookie}; another=value` },
      }),
      secret,
    );

    expect(accepted).toEqual({ id: minted.id });
  });

  test("replaces forged, malformed, and oversized cookie values", () => {
    const minted = resolveWaitlistClient(
      new Request("https://medlock.ai/api/waitlist"),
      secret,
    );
    const cookie = cookiePair(minted);
    const forged = `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`;

    for (const value of [forged, "medlock_waitlist_client=invalid", `junk=${"a".repeat(4_097)}`]) {
      const replacement = resolveWaitlistClient(
        new Request("https://medlock.ai/api/waitlist", { headers: { Cookie: value } }),
        secret,
      );

      expect(replacement.id).not.toBe(minted.id);
      expect(replacement.setCookie).toStartWith("medlock_waitlist_client=");
    }
  });

  test("rejects undersized signing secrets", () => {
    expect(() =>
      resolveWaitlistClient(
        new Request("https://medlock.ai/api/waitlist"),
        new Uint8Array(31),
      ),
    ).toThrow("at least 32 random bytes");
  });
});

function cookiePair(identity: WaitlistClientIdentity): string {
  const value = identity.setCookie?.split(";", 1)[0];
  if (!value) {
    throw new Error("expected a newly minted waitlist cookie");
  }

  return value;
}
