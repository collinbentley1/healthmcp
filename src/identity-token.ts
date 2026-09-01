import type { FetchLike } from "./firestore.ts";

// Verification of an Identity Platform ID token, done here rather than trusted.
//
// The browser never holds an API key in this design, so the only thing that
// crosses the boundary is a token, and a token is worth exactly what its
// verification is worth. Every claim that decides anything is checked against a
// value this service already knows: the signature against Google's published
// keys, the issuer and audience against the project, the expiry against the
// clock, and `email_verified` against the one thing the whole flow exists to
// establish.

export type VerifiedIdentity = {
  readonly email: string;
  readonly expiresAtMs: number;
  readonly issuedAtMs: number;
  readonly subject: string;
};

const GOOGLE_SECURETOKEN_JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_JWK_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 8 * 1024;
const CLOCK_SKEW_MS = 60_000;
// How recently the holder must have proved control of the address. Shorter
// than the token's own hour-long validity on purpose: this is the window in
// which a promotion may be performed, not the window in which the token
// remains parseable.
const MAX_AUTH_AGE_MS = 10 * 60 * 1_000;
const MAX_KID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 254;

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function integralSeconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is not an integral NumericDate`);
  }
  return value * 1_000;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("identity token contains a malformed base64url segment");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export class IdentityTokenVerifier {
  readonly #audience: string;
  readonly #fetch: FetchLike;
  #keys: { readonly expiresAtMs: number; readonly byKid: Map<string, CryptoKey> } | undefined;

  constructor(options: { audience: string; fetcher?: FetchLike }) {
    if (!/^[a-z][a-z0-9-]{4,29}$/.test(options.audience)) {
      throw new Error("identity token audience must be a Google Cloud project id");
    }
    this.#audience = options.audience;
    this.#fetch = options.fetcher ?? fetch;
  }

  async verify(token: string, nowMs: number): Promise<VerifiedIdentity> {
    // A non-finite clock makes every comparison below vacuously false, which is
    // the fail-open shape: an expired token would sail through.
    if (!Number.isFinite(nowMs)) {
      throw new Error("identity token verification requires a finite clock");
    }
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_BYTES) {
      throw new Error("identity token escaped its size bound");
    }
    const segments = token.split(".");
    if (segments.length !== 3) {
      throw new Error("identity token is not a three-segment JWS");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = asObject(
      JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedHeader))),
      "identity token header",
    );
    // The algorithm is pinned. Accepting whatever the token names is how "none"
    // and HMAC-with-the-public-key forgeries get in.
    if (header.alg !== "RS256") {
      throw new Error("identity token algorithm is not RS256");
    }
    if (
      typeof header.kid !== "string" || header.kid.length === 0 ||
      header.kid.length > MAX_KID_LENGTH
    ) {
      throw new Error("identity token names no usable signing key");
    }

    const key = await this.#keyFor(header.kid, nowMs);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!verified) {
      throw new Error("identity token signature did not verify");
    }

    const payload = asObject(
      JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))),
      "identity token payload",
    );
    if (payload.aud !== this.#audience) {
      throw new Error("identity token audience is not this project");
    }
    if (payload.iss !== `https://securetoken.google.com/${this.#audience}`) {
      throw new Error("identity token issuer is not this project's token service");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 128) {
      throw new Error("identity token subject is malformed");
    }
    // The entire purpose of the flow. A token for an address the provider has
    // not verified proves possession of nothing.
    if (payload.email_verified !== true) {
      throw new Error("identity token does not assert a verified email");
    }
    if (
      typeof payload.email !== "string" || payload.email.length === 0 ||
      payload.email.length > MAX_EMAIL_LENGTH
    ) {
      throw new Error("identity token carries no usable email");
    }
    // Integral seconds, as the spec requires. A fractional or non-integral
    // claim is not a NumericDate, and coercing one invites disagreement between
    // this check and anything else that reads the token.
    const exp = integralSeconds(payload.exp, "identity token expiry");
    const iat = integralSeconds(payload.iat, "identity token issuance");
    if (iat > exp) {
      throw new Error("identity token timing claims are malformed");
    }
    if (nowMs >= exp + CLOCK_SKEW_MS) {
      throw new Error("identity token has expired");
    }
    // Freshness, separately from expiry.
    //
    // An Identity Platform ID token stays valid for an hour, so `exp` alone
    // would let a token captured early be replayed for the rest of that hour
    // against an entry that had not yet been created. `auth_time` is when the
    // holder actually proved control of the address, and promotion requires
    // that proof to be recent -- which is a much tighter window than the
    // token's own lifetime and is not something the bearer can extend.
    // integralSeconds returns milliseconds, as `exp` and `iat` above already
    // are, so everything on this path is compared in one unit.
    const authTimeMs = integralSeconds(payload.auth_time, "identity token auth time");
    if (authTimeMs > iat + CLOCK_SKEW_MS) {
      throw new Error("identity token timing claims are malformed");
    }
    if (nowMs >= authTimeMs + MAX_AUTH_AGE_MS) {
      throw new Error("identity token authentication is too old to activate");
    }
    if (iat > nowMs + CLOCK_SKEW_MS) {
      throw new Error("identity token was issued in the future");
    }
    return {
      email: payload.email.trim().toLowerCase(),
      expiresAtMs: exp,
      issuedAtMs: iat,
      subject: payload.sub,
    };
  }

  async #keyFor(kid: string, nowMs: number): Promise<CryptoKey> {
    if (this.#keys === undefined || this.#keys.expiresAtMs <= nowMs) {
      this.#keys = await this.#fetchKeys(nowMs);
    }
    const cached = this.#keys.byKid.get(kid);
    if (cached !== undefined) return cached;
    // Google rotates these. Refusing an unknown kid until the cache expires
    // would turn every rotation into a ten-minute outage, so one forced refresh
    // is allowed -- exactly one, so an attacker cannot use unknown kids to
    // drive unbounded fetches.
    this.#keys = await this.#fetchKeys(nowMs);
    const refreshed = this.#keys.byKid.get(kid);
    if (refreshed === undefined) {
      throw new Error("identity token names an unknown signing key");
    }
    return refreshed;
  }

  async #fetchKeys(
    nowMs: number,
  ): Promise<{ expiresAtMs: number; byKid: Map<string, CryptoKey> }> {
    const response = await this.#fetch(GOOGLE_SECURETOKEN_JWK_URL);
    if (!response.ok) {
      throw new Error(`identity signing keys unavailable: ${response.status}`);
    }
    const raw = await response.text();
    if (raw.length > MAX_JWK_BYTES) {
      throw new Error("identity signing key set escaped its size bound");
    }
    const body = JSON.parse(raw) as { keys?: unknown };
    if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 32) {
      throw new Error("identity signing key set is malformed");
    }
    const byKid = new Map<string, CryptoKey>();
    for (const raw of body.keys) {
      const candidate = asObject(raw, "identity signing key");
      if (
        typeof candidate.kid !== "string" || candidate.kid.length === 0 ||
        candidate.kid.length > MAX_KID_LENGTH || candidate.kty !== "RSA" ||
        (candidate.alg !== undefined && candidate.alg !== "RS256")
      ) {
        throw new Error("identity signing key set contains an unusable key");
      }
      // Two entries claiming one kid make "which key signed this" ambiguous,
      // and last-one-wins would let a planted entry shadow the real key.
      if (byKid.has(candidate.kid)) {
        throw new Error("identity signing key set repeats a key id");
      }
      byKid.set(
        candidate.kid,
        await crypto.subtle.importKey(
          "jwk",
          { ...(candidate as JsonWebKey), alg: "RS256", ext: true, key_ops: ["verify"] },
          { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
          false,
          ["verify"],
        ),
      );
    }
    // Short, fixed cache. Google rotates these; a stale set would reject
    // legitimate tokens rather than accept bad ones, but it would still be an
    // outage, and an unbounded cache would make rotation invisible.
    return { byKid, expiresAtMs: nowMs + 10 * 60_000 };
  }
}
