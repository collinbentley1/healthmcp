import { readBoundedResponseJson } from "./bounded-response.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_ACCESS_TOKEN_LENGTH = 8_192;
const MAX_METADATA_BODY_BYTES = 4_096;
const MAX_RESPONSE_BODY_BYTES = 8_192;
const MAX_OOB_CODE_LENGTH = 512;
const MAX_LINK_STATE_LENGTH = 4_096;

// Sends the ownership challenge, server-side.
//
// The obvious way to do email-link sign-in is the public Identity Platform
// endpoint with a browser API key. That is rejected here. An API key is a
// public credential: anyone who reads the page can call sendOobCode with any
// address, which turns the project into an open mail relay pointed at
// arbitrary strangers and puts the resulting abuse on this domain's sending
// reputation. Referrer restrictions do not fix it either -- they are a browser
// convention, not an authorization boundary, and are trivially forged off a
// browser.
//
// This uses the Admin surface with the runtime service account instead. The
// endpoint is unauthenticated to nobody: only this server holds the identity
// that can call it, so a challenge can only be sent after the request has
// already passed the waitlist's shared quota and bot assessment. Dispatch is
// deliberately independent of existing membership.
export class IdentityPlatformClient {
  readonly #continueUrl: string;
  readonly #fetch: FetchLike;
  readonly #projectId: string;
  readonly #timeoutMs: number;
  #token: { readonly accessToken: string; readonly expiresAt: number } | undefined;

  constructor(options: {
    continueUrl: string;
    fetcher?: FetchLike;
    projectId: string;
    timeoutMs?: number;
  }) {
    const continueUrl = new URL(options.continueUrl);
    if (
      continueUrl.protocol !== "https:" ||
      continueUrl.username !== "" ||
      continueUrl.password !== "" ||
      continueUrl.search !== "" ||
      continueUrl.hash !== "" ||
      continueUrl.pathname !== "/api/waitlist/confirm"
    ) {
      throw new Error("Identity Platform continue URL must be a clean HTTPS confirmation endpoint");
    }
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(options.projectId)) {
      throw new Error("Identity Platform project id is invalid");
    }
    if (!Number.isSafeInteger(options.timeoutMs ?? 5_000) || (options.timeoutMs ?? 5_000) < 1) {
      throw new Error("Identity Platform timeout must be a positive integer");
    }
    this.#continueUrl = continueUrl.toString();
    this.#fetch = options.fetcher ?? fetch;
    this.#projectId = options.projectId;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  // Dispatches a single-use, short-lived sign-in link to `email`.
  //
  // Throws on any failure. The caller is expected to swallow that: whether a
  // send succeeded is information about whether the address is on the list,
  // and must not reach the response.
  async sendSignInLink(email: string, linkState: string, nowMs: number): Promise<void> {
    assertEmail(email);
    assertOpaque(linkState, MAX_LINK_STATE_LENGTH, "link state");
    assertNow(nowMs);
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${
        encodeURIComponent(this.#projectId)
      }/accounts:sendOobCode`,
      {
        body: JSON.stringify({
          canHandleCodeInApp: true,
          continueUrl: this.#continueUrlFor(linkState),
          email,
          requestType: "EMAIL_SIGNIN",
        }),
        headers: {
          Authorization: `Bearer ${await this.#accessToken(nowMs, deadline)}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        method: "POST",
        signal: deadline,
      },
    );
    if (!response.ok) {
      // Deliberately carries the status and nothing else. The address is the
      // one thing that must never reach a log line.
      throw new Error(`Identity Platform sendOobCode failed: ${response.status}`);
    }
  }

  // Proves that an OOB code was issued for an EMAIL_SIGNIN request and returns
  // the address Google bound to it.
  //
  // `accounts:signInWithEmailLink` is intentionally NOT used. Google's primary
  // REST contract requires an API key for that method even when OAuth scopes
  // are also listed. A key would add a long-lived credential that can reach
  // other Identity Toolkit methods if it is ever disclosed.
  //
  // `accounts:resetPassword`, despite its historical name, documents a
  // check-only operation: supplying only an OOB code returns the code's type
  // and email without consuming it. It accepts a short-lived OAuth bearer and
  // only PASSWORD_RESET codes can be consumed through that method. The
  // application therefore verifies EMAIL_SIGNIN possession here and performs
  // its own single-use, compare-and-swap promotion in Firestore.
  async verifyEmailLink(oobCode: string, nowMs: number): Promise<string> {
    assertOpaque(oobCode, MAX_OOB_CODE_LENGTH, "OOB code");
    assertNow(nowMs);
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:resetPassword",
      {
        body: JSON.stringify({ oobCode }),
        headers: {
          Authorization: `Bearer ${await this.#accessToken(nowMs, deadline)}`,
          "Content-Type": "application/json; charset=utf-8",
          // The OOB code is itself project-bound. This header makes the quota
          // and billing project explicit without pretending it can replace an
          // API key on methods whose contract requires one.
          "X-Goog-User-Project": this.#projectId,
        },
        method: "POST",
        signal: deadline,
      },
    );
    if (!response.ok) {
      // Status only. The OOB code is a live credential and the address must
      // never reach a log line.
      throw new Error(`Identity Platform OOB verification failed: ${response.status}`);
    }
    const body = await readBoundedResponseJson(
      response,
      MAX_RESPONSE_BODY_BYTES,
      "Identity Platform OOB verification",
    );
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Identity Platform OOB verification returned an unreadable body");
    }
    const result = body as {
      email?: unknown;
      requestType?: unknown;
    };
    if (result.requestType !== "EMAIL_SIGNIN") {
      throw new Error("Identity Platform OOB verification returned the wrong request type");
    }
    if (typeof result.email !== "string") {
      throw new Error("Identity Platform OOB verification returned no address");
    }
    const email = result.email.trim().toLowerCase();
    if (!isNormalizedEmail(email)) {
      throw new Error("Identity Platform OOB verification returned an invalid address");
    }
    return email;
  }

  // The return link carries authenticated, encrypted state. It contains the
  // address needed to bind the OOB-code response, but neither the address nor a
  // guessable email hash is exposed in the URL.
  #continueUrlFor(linkState: string): string {
    const url = new URL(this.#continueUrl);
    url.searchParams.set("state", linkState);
    return url.toString();
  }

  async #accessToken(nowMs: number, signal: AbortSignal): Promise<string> {
    if (this.#token && this.#token.expiresAt > nowMs + 60_000) {
      return this.#token.accessToken;
    }
    const response = await this.#fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal },
    );
    if (!response.ok) {
      throw new Error(`metadata token request failed: ${response.status}`);
    }
    const token = await readBoundedResponseJson(
      response,
      MAX_METADATA_BODY_BYTES,
      "metadata token response",
    ) as { access_token?: unknown; expires_in?: unknown };
    if (
      typeof token.access_token !== "string" ||
      token.access_token.length === 0 ||
      token.access_token.length > MAX_ACCESS_TOKEN_LENGTH ||
      typeof token.expires_in !== "number" ||
      !Number.isSafeInteger(token.expires_in) ||
      token.expires_in <= 0 ||
      token.expires_in > 86_400
    ) {
      throw new Error("metadata token response is invalid");
    }
    this.#token = {
      accessToken: token.access_token,
      expiresAt: nowMs + Number(token.expires_in) * 1000,
    };
    return token.access_token;
  }
}

function assertNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Identity Platform request time is invalid");
  }
}

function assertEmail(email: string): void {
  if (!isNormalizedEmail(email)) {
    throw new Error("Identity Platform address must be normalized");
  }
}

function isNormalizedEmail(email: string): boolean {
  return (
    email.length >= 3 &&
    email.length <= 254 &&
    email === email.trim().toLowerCase() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function assertOpaque(value: string, maxLength: number, label: string): void {
  if (value.length < 1 || value.length > maxLength || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error(`Identity Platform ${label} is invalid`);
  }
}
