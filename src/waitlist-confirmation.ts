import { Buffer } from "node:buffer";

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const VERSION = "v1";
const IV_BYTES = 12;
const LINK_TTL_MS = 30 * 60 * 1_000;
const BROWSER_PROOF_TTL_MS = 10 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 30 * 1_000;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_OOB_CODE_LENGTH = 512;

type Envelope = {
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly payload: unknown;
};

export class WaitlistConfirmationCodec {
  readonly #keys: readonly Uint8Array[];

  constructor(keys: readonly Uint8Array[]) {
    if (keys.length < 1 || keys.length > 2) {
      throw new Error("waitlist confirmation requires one active key and at most one prior key");
    }
    if (keys.some((key) => key.byteLength !== 32)) {
      throw new Error("waitlist confirmation keys must be exactly 32 bytes");
    }
    this.#keys = keys.map((key) => Uint8Array.from(key));
  }

  async sealLink(email: string, nowMs: number): Promise<string> {
    assertNow(nowMs);
    if (!isNormalizedEmail(email)) {
      throw new Error("waitlist confirmation email must be normalized");
    }
    return await this.#seal("link", { email }, nowMs, LINK_TTL_MS);
  }

  async openLink(token: string, nowMs: number): Promise<{ readonly email: string }> {
    const payload = await this.#open("link", token, nowMs, LINK_TTL_MS);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("waitlist confirmation link payload is invalid");
    }
    const email = (payload as { readonly email?: unknown }).email;
    if (typeof email !== "string" || !isNormalizedEmail(email)) {
      throw new Error("waitlist confirmation link email is invalid");
    }
    return { email };
  }

  async sealBrowserProof(linkState: string, oobCode: string, nowMs: number): Promise<string> {
    assertNow(nowMs);
    assertOpaqueToken(linkState, "link state");
    if (
      oobCode.length < 1 ||
      oobCode.length > MAX_OOB_CODE_LENGTH ||
      !/^[A-Za-z0-9._~-]+$/.test(oobCode)
    ) {
      throw new Error("waitlist confirmation OOB code is invalid");
    }
    return await this.#seal("browser", { linkState, oobCode }, nowMs, BROWSER_PROOF_TTL_MS);
  }

  async openBrowserProof(
    token: string,
    nowMs: number,
  ): Promise<{ readonly linkState: string; readonly oobCode: string }> {
    const payload = await this.#open("browser", token, nowMs, BROWSER_PROOF_TTL_MS);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("waitlist browser proof payload is invalid");
    }
    const source = payload as { readonly linkState?: unknown; readonly oobCode?: unknown };
    if (typeof source.linkState !== "string") {
      throw new Error("waitlist browser proof link state is invalid");
    }
    assertOpaqueToken(source.linkState, "link state");
    if (
      typeof source.oobCode !== "string" ||
      source.oobCode.length < 1 ||
      source.oobCode.length > MAX_OOB_CODE_LENGTH ||
      !/^[A-Za-z0-9._~-]+$/.test(source.oobCode)
    ) {
      throw new Error("waitlist browser proof OOB code is invalid");
    }
    return { linkState: source.linkState, oobCode: source.oobCode };
  }

  async #seal(
    purpose: "browser" | "link",
    payload: unknown,
    nowMs: number,
    ttlMs: number,
  ): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = UTF8.encode(JSON.stringify({
      expiresAt: nowMs + ttlMs,
      issuedAt: nowMs,
      payload,
    } satisfies Envelope));
    const ciphertext = await crypto.subtle.encrypt(
      {
        additionalData: asArrayBuffer(additionalData(purpose)),
        iv: asArrayBuffer(iv),
        name: "AES-GCM",
        tagLength: 128,
      },
      await deriveKey(this.#keys[0]!, purpose),
      plaintext,
    );
    return `${VERSION}.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
  }

  async #open(
    purpose: "browser" | "link",
    token: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<unknown> {
    assertNow(nowMs);
    assertOpaqueToken(token, "token");
    const [version, encodedIv, encodedCiphertext, extra] = token.split(".");
    if (version !== VERSION || extra !== undefined || !encodedIv || !encodedCiphertext) {
      throw new Error("waitlist confirmation token is malformed");
    }
    const iv = decodeBase64url(encodedIv);
    const ciphertext = decodeBase64url(encodedCiphertext);
    if (iv.byteLength !== IV_BYTES || ciphertext.byteLength < 17) {
      throw new Error("waitlist confirmation token is malformed");
    }

    let plaintext: ArrayBuffer | undefined;
    for (const key of this.#keys) {
      try {
        plaintext = await crypto.subtle.decrypt(
          {
            additionalData: asArrayBuffer(additionalData(purpose)),
            iv: asArrayBuffer(iv),
            name: "AES-GCM",
            tagLength: 128,
          },
          await deriveKey(key, purpose),
          asArrayBuffer(ciphertext),
        );
        break;
      } catch {
        // Key rotation: try the one prior key, then fail closed.
      }
    }
    if (plaintext === undefined) {
      throw new Error("waitlist confirmation token could not be authenticated");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(UTF8_DECODER.decode(plaintext));
    } catch {
      throw new Error("waitlist confirmation token payload is invalid");
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("waitlist confirmation token payload is invalid");
    }
    const envelope = decoded as Partial<Envelope>;
    if (
      !Number.isSafeInteger(envelope.issuedAt) ||
      !Number.isSafeInteger(envelope.expiresAt) ||
      envelope.expiresAt !== envelope.issuedAt! + ttlMs ||
      envelope.issuedAt! > nowMs + MAX_FUTURE_SKEW_MS ||
      envelope.expiresAt! <= nowMs
    ) {
      throw new Error("waitlist confirmation token is expired or invalid");
    }
    return envelope.payload;
  }
}

function assertNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("waitlist confirmation time is invalid");
  }
}

function assertOpaqueToken(value: string, label: string): void {
  if (value.length < 1 || value.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error(`waitlist confirmation ${label} is invalid`);
  }
}

function isNormalizedEmail(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 254 &&
    value === value.trim().toLowerCase() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function additionalData(purpose: "browser" | "link"): Uint8Array {
  return UTF8.encode(`medlock-waitlist-confirmation-${VERSION}:${purpose}`);
}

async function deriveKey(material: Uint8Array, purpose: "browser" | "link"): Promise<CryptoKey> {
  const source = await crypto.subtle.importKey("raw", asArrayBuffer(material), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      info: asArrayBuffer(additionalData(purpose)),
      name: "HKDF",
      salt: asArrayBuffer(UTF8.encode("medlock-waitlist-confirmation-hkdf-v1")),
    },
    source,
    { length: 256, name: "AES-GCM" },
    false,
    ["decrypt", "encrypt"],
  );
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("waitlist confirmation token is malformed");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("waitlist confirmation token is not canonical");
  }
  return Uint8Array.from(decoded);
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
