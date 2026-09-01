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
  async sendSignInLink(email: string, emailHash: string, nowMs: number): Promise<void> {
    const response = await this.#fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${
        encodeURIComponent(this.#projectId)
      }/accounts:sendOobCode`,
      {
        body: JSON.stringify({
          canHandleCodeInApp: true,
          continueUrl: this.#continueUrlFor(emailHash),
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

  // Turns the oobCode from a mailed link into an ID token, keylessly.
  //
  // The usual way to do this is `accounts:signInWithEmailLink` with a public
  // Firebase API key from the browser. That is the same surface rejected for
  // dispatch, for the same reason: a key that reaches a browser can be lifted
  // out of it and replayed against sendOobCode for arbitrary addresses. It is
  // also unnecessary. The Identity Toolkit discovery document declares this
  // method's auth as OAuth2 `cloud-platform`:
  //
  //   accounts.signInWithEmailLink
  //     path   : v1/accounts:signInWithEmailLink
  //     scopes : ['https://www.googleapis.com/auth/cloud-platform']
  //
  // so a short-lived service-account bearer token is sufficient and no
  // long-lived key needs to exist anywhere.
  async exchangeSignInLink(
    email: string,
    oobCode: string,
    nowMs: number,
  ): Promise<string> {
    const response = await this.#fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink",
      {
        body: JSON.stringify({ email, oobCode }),
        headers: {
          Authorization: `Bearer ${await this.#accessToken(nowMs)}`,
          "Content-Type": "application/json; charset=utf-8",
          // The method takes no targetProjectId, so the project is resolved
          // from the caller. Stated explicitly rather than left to whatever
          // the credential happens to default to.
          "X-Goog-User-Project": this.#projectId,
        },
        method: "POST",
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );
    if (!response.ok) {
      // Status only. An oobCode is a live single-use credential and the address
      // is the thing that must never be logged, so neither goes anywhere near
      // this message.
      throw new Error(`Identity Platform signInWithEmailLink failed: ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Identity Platform signInWithEmailLink returned an unreadable body");
    }
    const result = body as {
      email?: unknown;
      idToken?: unknown;
      mfaPendingCredential?: unknown;
    };
    // A second factor was required, so no ID token was issued. This is not a
    // partial success to be worked around: nothing has been proved yet.
    if (result.mfaPendingCredential !== undefined) {
      throw new Error("Identity Platform signInWithEmailLink requires a second factor");
    }
    if (typeof result.idToken !== "string" || result.idToken.length === 0) {
      throw new Error("Identity Platform signInWithEmailLink returned no ID token");
    }
    // The response echoes the address it signed in. It must be the one asked
    // for; the token is verified again by the caller regardless.
    if (typeof result.email !== "string" || result.email.trim().toLowerCase() !== email) {
      throw new Error("Identity Platform signInWithEmailLink returned a different address");
    }
    return result.idToken;
  }

  // The return link carries the entry's hash so the exchange can recover which
  // address to present alongside the oobCode.
  //
  // Putting the hash here is safe because it is not the secret: the oobCode is,
  // and it only ever exists inside the message delivered to that mailbox. An
  // attacker can compute the hash of any address they already know and learn
  // nothing, because without a live oobCode the exchange refuses.
  #continueUrlFor(emailHash: string): string {
    const url = new URL(this.#continueUrl);
    url.searchParams.set("h", emailHash);
    return url.toString();
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
