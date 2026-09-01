export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
// already passed the waitlist's own quota and membership checks.
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
    this.#continueUrl = options.continueUrl;
    this.#fetch = options.fetcher ?? fetch;
    this.#projectId = options.projectId;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  // Dispatches a single-use, short-lived sign-in link to `email`.
  //
  // Throws on any failure. The caller is expected to swallow that: whether a
  // send succeeded is information about whether the address is on the list,
  // and must not reach the response.
  async sendSignInLink(email: string, nowMs: number): Promise<void> {
    const response = await this.#fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${
        encodeURIComponent(this.#projectId)
      }/accounts:sendOobCode`,
      {
        body: JSON.stringify({
          canHandleCodeInApp: true,
          continueUrl: this.#continueUrl,
          email,
          requestType: "EMAIL_SIGNIN",
        }),
        headers: {
          Authorization: `Bearer ${await this.#accessToken(nowMs)}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        method: "POST",
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );
    if (!response.ok) {
      // Deliberately carries the status and nothing else. The address is the
      // one thing that must never reach a log line.
      throw new Error(`Identity Platform sendOobCode failed: ${response.status}`);
    }
  }

  async #accessToken(nowMs: number): Promise<string> {
    if (this.#token && this.#token.expiresAt > nowMs + 60_000) {
      return this.#token.accessToken;
    }
    const response = await this.#fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(this.#timeoutMs) },
    );
    if (!response.ok) {
      throw new Error(`metadata token request failed: ${response.status}`);
    }
    const token = (await response.json()) as { access_token: string; expires_in: number };
    if (typeof token.access_token !== "string" || token.access_token.length === 0) {
      throw new Error("metadata token response carried no access token");
    }
    this.#token = {
      accessToken: token.access_token,
      expiresAt: nowMs + Number(token.expires_in) * 1000,
    };
    return token.access_token;
  }
}
