import { describe, expect, test } from "bun:test";
import { IdentityTokenVerifier } from "../src/identity-token.ts";
import type { FetchLike } from "../src/firestore.ts";

// A real RSA key pair and real RS256 signatures. Nothing here asserts that the
// verifier "would" reject something -- every hostile token below is actually
// constructed and actually fed through the real verify path.
const PROJECT = "medlock-1025243085";
const NOW = Date.parse("2026-09-01T12:00:00.000Z");

const pair = await crypto.subtle.generateKey(
  { hash: "SHA-256", modulusLength: 2048, name: "RSASSA-PKCS1-v1_5", publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ["sign", "verify"],
);
const otherPair = await crypto.subtle.generateKey(
  { hash: "SHA-256", modulusLength: 2048, name: "RSASSA-PKCS1-v1_5", publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "kid-1" };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function signToken(options: {
  readonly header?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  readonly signWith?: CryptoKey;
}): Promise<string> {
  const header = { alg: "RS256", kid: "kid-1", typ: "JWT", ...options.header };
  const payload = {
    aud: PROJECT,
    email: "person@example.com",
    email_verified: true,
    auth_time: Math.floor(NOW / 1_000) - 60,
    exp: Math.floor(NOW / 1_000) + 3_600,
    iat: Math.floor(NOW / 1_000) - 60,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: "subject-1",
    ...options.payload,
  };
  const signing = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      options.signWith ?? pair.privateKey,
      new TextEncoder().encode(signing),
    ),
  );
  return `${signing}.${b64url(signature)}`;
}

const keyFetcher = (): FetchLike => async () => Response.json({ keys: [publicJwk] });
const verifier = (fetcher: FetchLike = keyFetcher()) =>
  new IdentityTokenVerifier({ audience: PROJECT, fetcher });

describe("identity token verification", () => {
  test("a well-formed token for this project verifies", async () => {
    const identity = await verifier().verify(await signToken({}), NOW);
    expect(identity.email).toBe("person@example.com");
    expect(identity.subject).toBe("subject-1");
  });

  test("an email is normalised the same way the store keys it", async () => {
    const identity = await verifier().verify(
      await signToken({ payload: { email: "  Person@Example.COM " } }),
      NOW,
    );
    expect(identity.email).toBe("person@example.com");
  });

  test("a token signed by another key is refused", async () => {
    await expect(
      verifier().verify(await signToken({ signWith: otherPair.privateKey }), NOW),
    ).rejects.toThrow("signature did not verify");
  });

  // An ID token remains parseable for an hour. Promotion is a much narrower
  // privilege than "this token is still valid", so it is gated on when the
  // holder actually proved control of the address.
  test("a token whose authentication is stale cannot activate", async () => {
    const stale = await signToken({
      payload: { auth_time: Math.floor(NOW / 1_000) - 11 * 60 },
    });
    // Still unexpired -- this is not the expiry check doing the work.
    await expect(verifier().verify(stale, NOW)).rejects.toThrow(/too old to activate/);
  });

  test("a token authenticated moments ago still activates", async () => {
    const fresh = await signToken({
      payload: { auth_time: Math.floor(NOW / 1_000) - 9 * 60 },
    });
    expect((await verifier().verify(fresh, NOW)).email).toBe("person@example.com");
  });

  test("auth_time cannot be pushed into the future to buy a longer window", async () => {
    await expect(
      verifier().verify(
        await signToken({ payload: { auth_time: Math.floor(NOW / 1_000) + 3_600 } }),
        NOW,
      ),
    ).rejects.toThrow(/malformed/);
  });

  test("a missing or non-integral auth_time is refused rather than defaulted", async () => {
    for (const authTime of [undefined, null, "1234567890", 1.5, Number.NaN]) {
      await expect(
        verifier().verify(await signToken({ payload: { auth_time: authTime } }), NOW),
      ).rejects.toThrow();
    }
  });

  test("a tampered payload is refused", async () => {
    const token = await signToken({});
    const [header, , signature] = token.split(".") as [string, string, string];
    const forged = encodeJson({
      aud: PROJECT,
      email: "victim@example.com",
      email_verified: true,
      auth_time: Math.floor(NOW / 1_000) - 60,
      exp: Math.floor(NOW / 1_000) + 3_600,
      iat: Math.floor(NOW / 1_000) - 60,
      iss: `https://securetoken.google.com/${PROJECT}`,
      sub: "subject-1",
    });
    await expect(verifier().verify(`${header}.${forged}.${signature}`, NOW))
      .rejects.toThrow("signature did not verify");
  });

  test.each([
    ["none", { alg: "none" }],
    ["HS256", { alg: "HS256" }],
  ])("a %s algorithm header is refused before any verification", async (_label, header) => {
    await expect(verifier().verify(await signToken({ header }), NOW))
      .rejects.toThrow("algorithm is not RS256");
  });

  test("a token for another project is refused", async () => {
    await expect(verifier().verify(await signToken({ payload: { aud: "someone-else" } }), NOW))
      .rejects.toThrow("audience is not this project");
  });

  test("a token from another issuer is refused", async () => {
    await expect(
      verifier().verify(
        await signToken({ payload: { iss: "https://securetoken.google.com/someone-else" } }),
        NOW,
      ),
    ).rejects.toThrow("issuer is not this project");
  });

  test("a token that does not assert a verified email is refused", async () => {
    // The entire point of the flow: possession of an unverified address proves
    // nothing about who controls it.
    await expect(verifier().verify(await signToken({ payload: { email_verified: false } }), NOW))
      .rejects.toThrow("does not assert a verified email");
    await expect(
      verifier().verify(await signToken({ payload: { email_verified: "true" } }), NOW),
    ).rejects.toThrow("does not assert a verified email");
  });

  test("an expired token is refused once it is past the skew", async () => {
    const token = await signToken({ payload: { exp: Math.floor(NOW / 1_000) - 1 } });
    // Inside the skew it still passes; well outside it does not.
    await expect(verifier().verify(token, NOW)).resolves.toBeDefined();
    await expect(verifier().verify(token, NOW + 5 * 60_000)).rejects.toThrow("has expired");
  });

  test("a token issued in the future is refused", async () => {
    await expect(
      verifier().verify(
        await signToken({ payload: { iat: Math.floor(NOW / 1_000) + 3_600 } }),
        NOW,
      ),
    ).rejects.toThrow("issued in the future");
  });

  test("a token naming an unknown signing key is refused", async () => {
    await expect(verifier().verify(await signToken({ header: { kid: "kid-unknown" } }), NOW))
      .rejects.toThrow("unknown signing key");
  });

  test("an unavailable key set fails closed", async () => {
    await expect(
      verifier(async () => new Response("", { status: 503 })).verify(await signToken({}), NOW),
    ).rejects.toThrow("signing keys unavailable: 503");
  });

  test("a key set containing an unusable key is refused whole", async () => {
    await expect(
      verifier(async () => Response.json({ keys: [{ ...publicJwk, kty: "oct" }] }))
        .verify(await signToken({}), NOW),
    ).rejects.toThrow("unusable key");
  });

  test.each([
    ["not a JWS", "only.two"],
    ["empty", ""],
  ])("a token that is %s is refused", async (_label, token) => {
    await expect(verifier().verify(token, NOW)).rejects.toThrow();
  });

  test("an oversized token is refused before it is parsed", async () => {
    await expect(verifier().verify("a".repeat(9_000), NOW)).rejects.toThrow("size bound");
  });

  test("the key set is cached, then refreshed", async () => {
    let fetches = 0;
    const counting = verifier(async () => {
      fetches += 1;
      return Response.json({ keys: [publicJwk] });
    });
    await counting.verify(await signToken({}), NOW);
    await counting.verify(await signToken({}), NOW + 60_000);
    expect(fetches).toBe(1);
    // Authenticated at the advanced clock, so this exercises the key cache
    // rather than the separate auth_time freshness bound.
    const later = Math.floor((NOW + 11 * 60_000) / 1_000);
    await counting.verify(
      await signToken({ payload: { auth_time: later - 60, exp: later + 3_600, iat: later - 60 } }),
      NOW + 11 * 60_000,
    );
    expect(fetches).toBe(2);
  });

  test("a non-finite clock is refused rather than passing every comparison", async () => {
    // NaN makes every timing comparison false, which is the fail-open shape: an
    // expired token would sail straight through.
    const token = await signToken({ payload: { exp: Math.floor(NOW / 1_000) - 10_000 } });
    await expect(verifier().verify(token, Number.NaN)).rejects.toThrow("finite clock");
    await expect(verifier().verify(token, Number.POSITIVE_INFINITY)).rejects.toThrow("finite clock");
  });

  test.each([
    ["fractional", 1_800_000_000.5],
    ["a string", "1800000000"],
    ["negative", -1],
    ["zero", 0],
  ])("an expiry that is %s is refused", async (_label, exp) => {
    await expect(verifier().verify(await signToken({ payload: { exp } }), NOW))
      .rejects.toThrow("integral NumericDate");
  });

  test("an issuance that is not an integral NumericDate is refused", async () => {
    await expect(verifier().verify(await signToken({ payload: { iat: 1.5 } }), NOW))
      .rejects.toThrow("integral NumericDate");
  });

  test.each([
    ["an array header", [1, 2, 3]],
    ["a string header", "header"],
    ["a null header", null],
  ])("%s is refused", async (_label, header) => {
    const encoded = b64url(new TextEncoder().encode(JSON.stringify(header)));
    const rest = (await signToken({})).split(".").slice(1).join(".");
    await expect(verifier().verify(`${encoded}.${rest}`, NOW)).rejects.toThrow();
  });

  test("an oversized kid is refused", async () => {
    await expect(verifier().verify(await signToken({ header: { kid: "k".repeat(300) } }), NOW))
      .rejects.toThrow("no usable signing key");
  });

  test("an oversized email is refused", async () => {
    await expect(
      verifier().verify(
        await signToken({ payload: { email: `${"a".repeat(250)}@example.com` } }),
        NOW,
      ),
    ).rejects.toThrow("no usable email");
  });

  test("a key set that repeats a key id is refused whole", async () => {
    // Last-one-wins would let a planted entry shadow the real key.
    await expect(
      verifier(async () => Response.json({ keys: [publicJwk, { ...publicJwk }] }))
        .verify(await signToken({}), NOW),
    ).rejects.toThrow("repeats a key id");
  });

  test("key rotation refreshes once instead of failing for the cache lifetime", async () => {
    // A rotated kid must not be a ten-minute outage.
    let served = 0;
    const rotating = verifier(async () => {
      served += 1;
      return served === 1
        ? Response.json({ keys: [{ ...publicJwk, kid: "kid-old" }] })
        : Response.json({ keys: [publicJwk] });
    });

    await expect(rotating.verify(await signToken({}), NOW)).resolves.toBeDefined();
    expect(served).toBe(2);
  });

  test("an unknown key id costs exactly one forced refresh, not unbounded fetches", async () => {
    let served = 0;
    const counting = verifier(async () => {
      served += 1;
      return Response.json({ keys: [publicJwk] });
    });

    await expect(counting.verify(await signToken({ header: { kid: "kid-nope" } }), NOW))
      .rejects.toThrow("unknown signing key");
    // One initial fetch plus one forced refresh, and no more: otherwise unknown
    // kids would be a way to drive traffic at Google on demand.
    expect(served).toBe(2);
  });

  test("the audience must be a project id, not an arbitrary string", () => {
    expect(() => new IdentityTokenVerifier({ audience: "" })).toThrow("project id");
    expect(() => new IdentityTokenVerifier({ audience: "Not A Project" })).toThrow("project id");
  });
});
