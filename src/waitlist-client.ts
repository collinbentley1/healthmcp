import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "medlock_waitlist_client";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_COOKIE_HEADER_LENGTH = 4_096;

export type WaitlistClientIdentity = {
  readonly id: string;
  readonly setCookie?: string;
};

export function createWaitlistIdentitySecret(): Uint8Array {
  return randomBytes(32);
}

export function resolveWaitlistClient(
  request: Request,
  secret: Uint8Array,
): WaitlistClientIdentity {
  if (secret.byteLength < 32) {
    throw new Error("waitlist identity secret must contain at least 32 random bytes");
  }

  const existing = readCookie(request.headers.get("cookie"));
  if (existing) {
    const [id, signature, extra] = existing.split(".");
    if (!extra && id && signature && isValidId(id) && isAuthentic(id, signature, secret)) {
      return { id };
    }
  }

  const id = randomBytes(18).toString("base64url");
  const value = `${id}.${sign(id, secret)}`;

  return {
    id,
    setCookie: `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/api/waitlist; HttpOnly; SameSite=Strict; Secure`,
  };
}

function readCookie(header: string | null): string | undefined {
  if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }

    if (part.slice(0, separator).trim() === COOKIE_NAME) {
      return part.slice(separator + 1).trim();
    }
  }

  return undefined;
}

function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]{24}$/.test(id);
}

function sign(id: string, secret: Uint8Array): string {
  return createHmac("sha256", secret).update(id).digest("base64url");
}

function isAuthentic(id: string, signature: string, secret: Uint8Array): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return false;
  }

  const expected = Buffer.from(sign(id, secret));
  const supplied = Buffer.from(signature);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
