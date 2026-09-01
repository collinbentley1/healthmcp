import { readBoundedResponseJson } from "./bounded-response.ts";

export type RecaptchaFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type RecaptchaAssessment = {
  readonly action: string;
  readonly hostname: string;
  readonly score: number;
};

const MAX_ACCESS_TOKEN_LENGTH = 8_192;
const MAX_ASSESSMENT_BODY_BYTES = 16_384;
const MAX_METADATA_BODY_BYTES = 4_096;
const MAX_TOKEN_BYTES = 4_096;
const MAX_TOKEN_AGE_MS = 2 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 30 * 1_000;

export class RecaptchaEnterpriseClient {
  readonly #allowedHostnames: ReadonlySet<string>;
  readonly #fetch: RecaptchaFetch;
  readonly #minimumScore: number;
  readonly #projectId: string;
  readonly #siteKey: string;
  readonly #timeoutMs: number;
  #token: { readonly accessToken: string; readonly expiresAt: number } | undefined;

  constructor(options: {
    allowedHostnames: readonly string[];
    fetcher?: RecaptchaFetch;
    minimumScore?: number;
    projectId: string;
    siteKey: string;
    timeoutMs?: number;
  }) {
    if (options.allowedHostnames.length === 0) {
      throw new Error("reCAPTCHA requires at least one allowed hostname");
    }
    this.#allowedHostnames = new Set(options.allowedHostnames.map(normalizeHostname));
    this.#fetch = options.fetcher ?? fetch;
    this.#minimumScore = options.minimumScore ?? 0.7;
    this.#projectId = options.projectId;
    this.#siteKey = options.siteKey;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(this.#projectId)) {
      throw new Error("reCAPTCHA project id is invalid");
    }
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(this.#siteKey)) {
      throw new Error("reCAPTCHA site key is invalid");
    }
    if (!Number.isFinite(this.#minimumScore) || this.#minimumScore < 0 || this.#minimumScore > 1) {
      throw new Error("reCAPTCHA minimum score must be between zero and one");
    }
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error("reCAPTCHA timeout must be a positive integer");
    }
  }

  async assess(
    token: string,
    expectedAction: string,
    nowMs: number,
    userAgent?: string,
  ): Promise<RecaptchaAssessment> {
    const tokenBytes = new TextEncoder().encode(token).byteLength;
    if (
      tokenBytes < 1 ||
      tokenBytes > MAX_TOKEN_BYTES
    ) {
      throw new Error("reCAPTCHA token has an invalid size");
    }
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(expectedAction)) {
      throw new Error("reCAPTCHA action is invalid");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("reCAPTCHA assessment time is invalid");
    }

    // One deadline covers token acquisition and assessment. A first metadata
    // or API fetch that never returns must not hold a public request open for
    // the Cloud Run request timeout.
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#fetch(
      `https://recaptchaenterprise.googleapis.com/v1/projects/${encodeURIComponent(this.#projectId)}/assessments`,
      {
        body: JSON.stringify({
          event: {
            expectedAction,
            siteKey: this.#siteKey,
            token,
            ...(userAgent ? { userAgent: userAgent.slice(0, 512) } : {}),
          },
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
      throw new Error(`reCAPTCHA assessment failed: ${response.status}`);
    }

    const body = await readBoundedResponseJson(
      response,
      MAX_ASSESSMENT_BODY_BYTES,
      "reCAPTCHA assessment",
    );
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("reCAPTCHA assessment returned an unreadable body");
    }
    const assessment = body as {
      readonly riskAnalysis?: { readonly score?: unknown };
      readonly tokenProperties?: {
        readonly action?: unknown;
        readonly createTime?: unknown;
        readonly hostname?: unknown;
        readonly valid?: unknown;
      };
    };
    const properties = assessment.tokenProperties;
    if (properties?.valid !== true) {
      throw new Error("reCAPTCHA token is invalid");
    }
    if (properties.action !== expectedAction) {
      throw new Error("reCAPTCHA token action does not match");
    }
    if (typeof properties.hostname !== "string") {
      throw new Error("reCAPTCHA token has no hostname");
    }
    const hostname = normalizeHostname(properties.hostname);
    if (!this.#allowedHostnames.has(hostname)) {
      throw new Error("reCAPTCHA token hostname is not allowed");
    }
    if (typeof properties.createTime !== "string") {
      throw new Error("reCAPTCHA token has no creation time");
    }
    const createdAt = Date.parse(properties.createTime);
    if (
      !Number.isFinite(createdAt) ||
      createdAt < nowMs - MAX_TOKEN_AGE_MS ||
      createdAt > nowMs + MAX_FUTURE_SKEW_MS
    ) {
      throw new Error("reCAPTCHA token is stale");
    }
    const score = assessment.riskAnalysis?.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < this.#minimumScore || score > 1) {
      throw new Error("reCAPTCHA assessment score is too low");
    }
    return { action: expectedAction, hostname, score };
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
      expiresAt: nowMs + token.expires_in * 1_000,
    };
    return token.access_token;
  }
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !/^[a-z0-9.-]+$/.test(hostname) ||
    hostname.startsWith(".") ||
    hostname.endsWith(".") ||
    hostname.includes("..")
  ) {
    throw new Error("reCAPTCHA hostname is invalid");
  }
  return hostname;
}
