import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { BUILT_PUBLIC_DIR, getRuntimeConfig, type RuntimeConfig } from "./config.ts";
import {
  corsHeaders,
  isTrustedHost,
  json,
  shouldRedirectToCanonical,
  text,
  withSecurityHeaders,
  type JsonResponseOptions,
} from "./http.ts";
import { createMcpEndpoint, type McpEndpoint } from "./mcp.ts";
import { InMemoryRateLimiter, type RateLimitRule } from "./rate-limit.ts";
import {
  createWaitlistIdentitySecret,
  resolveWaitlistClient,
} from "./waitlist-client.ts";
import { FirestoreClient } from "./firestore.ts";
import {
  FirestoreWaitlistQuota,
  MemoryWaitlistQuota,
  type QuotaRule,
  type WaitlistQuota,
} from "./waitlist-quota.ts";
import { IdentityPlatformClient } from "./identity-platform.ts";
import { RecaptchaEnterpriseClient } from "./recaptcha.ts";
import { WaitlistConfirmationCodec } from "./waitlist-confirmation.ts";
import {
  createWaitlistStore,
  isValidEmail,
  normalizeEmail,
  sha256,
  submitWaitlist,
  type WaitlistStore,
} from "./waitlist.ts";

type ServerDependencies = {
  readonly config?: RuntimeConfig;
  readonly mcpEndpoint?: McpEndpoint;
  readonly now?: () => Date;
  readonly rateLimiter?: InMemoryRateLimiter;
  readonly waitlistIdentitySecrets?: readonly Uint8Array[];
  readonly waitlistQuota?: WaitlistQuota;
  readonly waitlistStore?: WaitlistStore;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly monotonicNow?: () => number;
  readonly confirmationCodec?: Pick<
    WaitlistConfirmationCodec,
    "openBrowserProof" | "openLink" | "sealBrowserProof" | "sealLink"
  >;
  readonly identityDispatcher?: {
    sendSignInLink: IdentityPlatformClient["sendSignInLink"];
    verifyEmailLink: IdentityPlatformClient["verifyEmailLink"];
  };
  readonly recaptcha?: Pick<RecaptchaEnterpriseClient, "assess">;
};

export const MAX_REQUEST_BODY_SIZE = 1_048_576;
const MAX_WAITLIST_BODY_SIZE = 8_192;
// Identity Platform oobCodes are far shorter than this; the bound exists so a
// megabyte of query string is refused before it is pattern-matched.
const MAX_OOB_CODE_LENGTH = 512;

// Every answer this endpoint can give about a submitted address is the same
// answer, so the floor only has to hide the difference in work between
// "created" and "already there". One create attempt happens either way; the
// floor covers the storage engine's own variance.
export const WAITLIST_TIMING_FLOOR_MS = 300;
export const WAITLIST_TIMING_JITTER_MS = 120;

// Unpredictable to the caller: drawn from the CSPRNG, not Math.random, because
// a predictable pad is a pad an attacker can subtract back out.
function waitlistTimingJitterMs(): number {
  const draw = new Uint32Array(1);
  crypto.getRandomValues(draw);
  return (draw[0]! / 2 ** 32) * WAITLIST_TIMING_JITTER_MS;
}

// The authoritative buckets. There is deliberately no low shared
// "unestablished client" bucket: one anonymous caller could fill it with
// invalid tokens and deny every new browser. Before attestation, a high global
// cost ceiling is combined with independently scoped address and signed-client
// buckets. After attestation, the global delivery ceiling, address budget, and
// signed-client bucket bound mail. A caller can discard its cookie, but doing so
// neither creates a shared five-request choke point nor escapes the global and
// per-address bounds.
export const WAITLIST_QUOTA_LIMITS = {
  assessmentGlobal: { limit: 120, windowSeconds: 60 },
  assessmentSubject: { limit: 5, windowSeconds: 60 },
  client: { limit: 5, windowSeconds: 60 },
  email: { limit: 2, windowSeconds: 86_400 },
  global: { limit: 60, windowSeconds: 60 },
} as const;
const WAITLIST_JOIN_ACTION = "waitlist_join";
const WAITLIST_CONFIRM_ACTION = "waitlist_confirm";
const CONFIRMATION_COOKIE = "__Host-medlock-waitlist-confirmation";
const UTF8 = new TextEncoder();

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export function createHandler(dependencies: ServerDependencies = {}): (request: Request) => Promise<Response> {
  const config = dependencies.config ?? getRuntimeConfig();
  const firestoreClient = config.waitlistBackend === "firestore" && config.firestoreProjectId
    ? new FirestoreClient({
      databaseId: config.firestoreDatabaseId,
      projectId: config.firestoreProjectId,
    })
    : undefined;
  const waitlistStore = dependencies.waitlistStore ?? createWaitlistStore(config, firestoreClient);
  // Firestore decides whether a request is abusive whenever this service is
  // deployed. The in-process limiter below it is a cheap first pass only; it
  // was never able to be the limit, because every Cloud Run instance had its
  // own copy of it.
  const waitlistQuota = dependencies.waitlistQuota ??
    (firestoreClient
      ? new FirestoreWaitlistQuota({
        client: firestoreClient,
        collection: `${config.firestoreCollection}_quota`,
      })
      : new MemoryWaitlistQuota());
  const sleep = dependencies.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const waitlistIdentitySecrets =
    dependencies.waitlistIdentitySecrets ??
    (config.waitlistIdentitySecrets.length > 0
      ? config.waitlistIdentitySecrets
      : [createWaitlistIdentitySecret()]);
  const confirmationCodec = dependencies.confirmationCodec ??
    (waitlistIdentitySecrets.length === 0
      ? undefined
      : new WaitlistConfirmationCodec(waitlistIdentitySecrets));
  // Dispatch needs both halves: the project used by the OAuth-only ownership
  // calls, and the destination the mailed link may return to. Missing either
  // means the flow is not provisioned, and every address is refused alike rather
  // than leaving a partially working verification path.
  const identityDispatcher = dependencies.identityDispatcher ??
    (config.identityPlatformAudience === undefined ||
        config.identityPlatformContinueUrl === undefined
      ? undefined
      : new IdentityPlatformClient({
        continueUrl: config.identityPlatformContinueUrl,
        projectId: config.identityPlatformAudience,
      }));
  const recaptcha = dependencies.recaptcha ??
    (config.recaptchaProjectId === undefined || config.recaptchaSiteKey === undefined
      ? undefined
      : new RecaptchaEnterpriseClient({
        allowedHostnames: [config.canonicalHost, `www.${config.canonicalHost}`],
        projectId: config.recaptchaProjectId,
        siteKey: config.recaptchaSiteKey,
      }));
  const rateLimiter = dependencies.rateLimiter ?? new InMemoryRateLimiter();
  const mcpEndpoint = dependencies.mcpEndpoint ?? createMcpEndpoint(config);
  const now = dependencies.now ?? (() => new Date());

  return async function handleRequest(request: Request): Promise<Response> {
    const healthUrl = new URL(request.url);
    if (healthUrl.pathname === "/livez") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return text("method not allowed", { headers: { Allow: "GET, HEAD" }, status: 405 });
      }

      const deployment = Bun.env.PLATFORM_DEPLOY_NONCE;
      const payload = deployment ? { ok: true, deployment } : { ok: true };
      const response = json(payload, {
        headers: {
          "Content-Length": String(UTF8.encode(JSON.stringify(payload)).byteLength),
        },
      });
      return request.method === "HEAD" ? withoutBody(response) : response;
    }

    if (!isTrustedHost(request, config)) {
      return text("untrusted host", { status: 400 });
    }

    const canonicalRedirect = shouldRedirectToCanonical(request, config);
    if (canonicalRedirect) {
      return withSecurityHeaders(new Response(null, { headers: { Location: canonicalRedirect.href }, status: 308 }));
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/waitlist") {
        return await handleWaitlist(
          request,
          config,
          waitlistStore,
          waitlistQuota,
          rateLimiter,
          identityDispatcher,
          confirmationCodec,
          recaptcha,
          waitlistIdentitySecrets,
          now,
          sleep,
          monotonicNow,
        );
      }

      if (url.pathname === "/api/waitlist/config") {
        return handleWaitlistConfig(request, config, recaptcha);
      }

      if (url.pathname === "/api/waitlist/confirm") {
        return await handleWaitlistConfirm(
          request,
          url,
          config,
          waitlistStore,
          waitlistQuota,
          rateLimiter,
          identityDispatcher,
          confirmationCodec,
          recaptcha,
          waitlistIdentitySecrets,
          now,
        );
      }

      if (url.pathname === "/api/mcp") {
        return await mcpEndpoint.handle(request);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return text("method not allowed", { headers: { Allow: "GET, HEAD" }, status: 405 });
      }

      if (url.pathname === "/scan") {
        return await serveStatic("/scan.html", config, request.method === "HEAD");
      }

      if (url.pathname === "/waitlist/confirm") {
        return await serveStatic("/waitlist-confirm.html", config, request.method === "HEAD");
      }

      return await serveStatic(url.pathname, config, request.method === "HEAD");
    } catch (error) {
      console.error("request failed", error instanceof Error ? error.name : "unknown error");
      return url.pathname.startsWith("/api/")
        ? apiJson({ error: "internal server error" }, request, config, { status: 500 })
        : json({ error: "internal server error" }, { status: 500 });
    }
  };
}

export const handleRequest = createHandler();

export function startServer(
  config: RuntimeConfig = getRuntimeConfig(),
  dependencies: Omit<ServerDependencies, "config"> = {},
): ReturnType<typeof Bun.serve> {
  const handler = createHandler({ ...dependencies, config });
  return Bun.serve({
    development: false,
    error(error) {
      console.error("server error", error instanceof Error ? error.name : "unknown error");
      return json({ error: "internal server error" }, { status: 500 });
    },
    fetch(request) {
      return handler(request);
    },
    hostname: "0.0.0.0",
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    port: config.port,
  });
}

if (import.meta.main) {
  const server = startServer();

  console.info(`medlock listening on ${server.url}`);
}

async function handleWaitlist(
  request: Request,
  config: RuntimeConfig,
  store: WaitlistStore,
  quota: WaitlistQuota,
  rateLimiter: InMemoryRateLimiter,
  dispatcher: {
    sendSignInLink: IdentityPlatformClient["sendSignInLink"];
  } | undefined,
  confirmationCodec: Pick<WaitlistConfirmationCodec, "sealLink"> | undefined,
  recaptcha: Pick<RecaptchaEnterpriseClient, "assess"> | undefined,
  identitySecrets: readonly Uint8Array[],
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
  monotonicNow: () => number,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withSecurityHeaders(new Response(null, { headers: corsHeaders(request, config), status: 204 }));
  }

  if (request.method !== "POST") {
    return apiJson({ error: "method not allowed" }, request, config, { headers: { Allow: "POST, OPTIONS" }, status: 405 });
  }
  if (
    !config.waitlistActivationEnabled ||
    dispatcher === undefined ||
    confirmationCodec === undefined ||
    recaptcha === undefined
  ) {
    return apiJson({ error: "waitlist verification is not available" }, request, config, {
      status: 503,
    });
  }

  const client = resolveWaitlistClient(request, identitySecrets);
  const respond = (response: Response): Response => withWaitlistClientCookie(response, client.setCookie);
  const clientQuotaSubject = sha256(client.id).slice(0, 32);

  // Defence in depth, not the limit. This sheds an obvious flood before the
  // request costs a network round trip, but it is per-instance and so can never
  // be the thing that decides.
  const localRules: RateLimitRule[] = [
    { key: `waitlist:client:${client.id}`, limit: WAITLIST_QUOTA_LIMITS.client.limit, windowMs: 60_000 },
    {
      key: "waitlist:assessment-global",
      limit: WAITLIST_QUOTA_LIMITS.assessmentGlobal.limit,
      windowMs: 60_000,
    },
  ];
  const local = rateLimiter.checkMany(localRules);
  if (!local.allowed) {
    const response = rateLimitedWaitlistResponse(request, config, local.retryAfterSeconds);
    return respond(response);
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return respond(apiJson({ error: "expected application/json" }, request, config, { status: 415 }));
  }

  const parsedBody = await readBoundedJson(request, MAX_WAITLIST_BODY_SIZE);
  if (parsedBody.kind === "too-large") {
    return respond(apiJson({ error: "request body too large" }, request, config, { status: 413 }));
  }

  if (parsedBody.kind === "invalid") {
    return respond(apiJson({ error: "invalid JSON body" }, request, config, { status: 400 }));
  }

  const body = parsedBody.value as {
    email?: unknown;
    recaptchaToken?: unknown;
    source?: unknown;
  } | undefined;
  if (!body || typeof body.email !== "string" || typeof body.recaptchaToken !== "string") {
    return respond(apiJson({ error: "email and verification are required" }, request, config, { status: 400 }));
  }
  const normalizedEmail = normalizeEmail(body.email);
  if (!isValidEmail(normalizedEmail)) {
    return respond(apiJson({ error: "Enter a valid email address." }, request, config, { status: 400 }));
  }
  const addressQuotaSubject = sha256(normalizedEmail).slice(0, 32);

  // First bound assessment cost globally. These are distinct from the mail
  // budgets below, so a flood of invalid attestation tokens cannot exhaust the
  // capacity reserved for people who pass the bot check.
  const assessmentRules: QuotaRule[] = [
    {
      key: "waitlist:assessment-global",
      limit: WAITLIST_QUOTA_LIMITS.assessmentGlobal.limit,
      windowSeconds: WAITLIST_QUOTA_LIMITS.assessmentGlobal.windowSeconds,
    },
    {
      key: `waitlist:assessment-address:${addressQuotaSubject}`,
      limit: WAITLIST_QUOTA_LIMITS.assessmentSubject.limit,
      windowSeconds: WAITLIST_QUOTA_LIMITS.assessmentSubject.windowSeconds,
    },
    {
      key: `waitlist:assessment-client:${clientQuotaSubject}`,
      limit: WAITLIST_QUOTA_LIMITS.client.limit,
      windowSeconds: WAITLIST_QUOTA_LIMITS.client.windowSeconds,
    },
  ];

  let decision;
  try {
    decision = await quota.consume(assessmentRules, now());
  } catch (error) {
    // Fail closed. If the shared counter cannot be advanced, this instance has
    // no idea how much of the budget is already spent, and guessing in the
    // permissive direction is exactly how a distributed limit becomes no limit.
    console.error("waitlist quota unavailable", error instanceof Error ? error.name : "unknown error");
    return respond(
      apiJson({ error: "waitlist temporarily unavailable" }, request, config, {
        headers: { "Retry-After": "60" },
        status: 503,
      }),
    );
  }
  if (!decision.allowed) {
    const response = rateLimitedWaitlistResponse(request, config, decision.retryAfterSeconds);
    return respond(response);
  }

  const observedAt = now();
  try {
    await recaptcha.assess(
      body.recaptchaToken,
      WAITLIST_JOIN_ACTION,
      observedAt.getTime(),
      request.headers.get("user-agent") ?? undefined,
    );
  } catch (error) {
    console.error("waitlist attestation refused", error instanceof Error ? error.name : "unknown error");
    return respond(apiJson({ error: "request could not be verified" }, request, config, { status: 403 }));
  }

  // The authoritative mail decision, shared by every instance. The address
  // bucket is keyed by a hash, never by plaintext, and is only spent after a
  // valid, single-use reCAPTCHA assessment.
  const deliveryRules: QuotaRule[] = [
    {
      key: "waitlist:global",
      limit: WAITLIST_QUOTA_LIMITS.global.limit,
      windowSeconds: WAITLIST_QUOTA_LIMITS.global.windowSeconds,
    },
    {
      key: `waitlist:email:${addressQuotaSubject}`,
      limit: WAITLIST_QUOTA_LIMITS.email.limit,
      windowSeconds: WAITLIST_QUOTA_LIMITS.email.windowSeconds,
    },
    {
      key: `waitlist:client:${clientQuotaSubject}`,
      limit: WAITLIST_QUOTA_LIMITS.client.limit,
      windowSeconds: WAITLIST_QUOTA_LIMITS.client.windowSeconds,
    },
  ];
  try {
    decision = await quota.consume(deliveryRules, observedAt);
  } catch (error) {
    console.error("waitlist delivery quota unavailable", error instanceof Error ? error.name : "unknown error");
    return respond(apiJson({ error: "waitlist temporarily unavailable" }, request, config, {
      headers: { "Retry-After": "60" },
      status: 503,
    }));
  }
  if (!decision.allowed) {
    const response = rateLimitedWaitlistResponse(request, config, decision.retryAfterSeconds);
    return respond(response);
  }

  // From here to the response, every path costs the same wall time and returns
  // the same bytes. Nothing downstream may branch on whether the address was
  // already present.
  // Measured on a MONOTONIC clock, not the wall clock. `now()` is the injected
  // Date source and can step backwards or jump -- an NTP correction mid-request
  // would make `elapsed` negative or huge and either remove the pad entirely or
  // stall the response.
  const startedAt = monotonicNow();
  const settle = async (response: Response): Promise<Response> => {
    const elapsed = monotonicNow() - startedAt;
    // Floor plus bounded unpredictable jitter. The floor alone equalises the
    // two paths only while both finish under it; the jitter means a single
    // observation carries less information about which side of the floor the
    // work actually landed on, and repeated sampling has to average through
    // noise the attacker does not control.
    const target = WAITLIST_TIMING_FLOOR_MS + waitlistTimingJitterMs();
    if (elapsed < target) await sleep(target - elapsed);
    return respond(response);
  };

  try {
    const result = await submitWaitlist(
      store,
      {
        email: normalizedEmail,
        clientId: client.id,
        source: typeof body.source === "string" ? body.source : "site",
        userAgent: request.headers.get("user-agent") ?? undefined,
      },
      observedAt,
    );
    if (!result.ok) {
      return await settle(apiJson({ error: result.error }, request, config, { status: result.status }));
    }

    // The provider call happens for every accepted submission, including an
    // already-present or already-confirmed address. There is no membership
    // branch to infer from latency. Bot attestation and the global/address
    // quotas are what make this standard double-opt-in send surface bounded.
    const linkState = await confirmationCodec.sealLink(normalizedEmail, observedAt.getTime());
    await dispatcher.sendSignInLink(normalizedEmail, linkState, observedAt.getTime());
  } catch (error) {
    console.error("waitlist submission unavailable", error instanceof Error ? error.name : "unknown error");
    return await settle(apiJson({ error: "waitlist temporarily unavailable" }, request, config, {
      headers: { "Retry-After": "60" },
      status: 503,
    }));
  }

  // Whether the store created, refreshed, or found the entry never leaves this
  // process. The response is identical and a message was attempted in all
  // cases, so neither bytes nor provider latency answer a membership question.
  return await settle(apiJson({ ok: true }, request, config, { status: 202 }));
}


function handleWaitlistConfig(
  request: Request,
  config: RuntimeConfig,
  recaptcha: Pick<RecaptchaEnterpriseClient, "assess"> | undefined,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return apiJson({ error: "method not allowed" }, request, config, {
      headers: { Allow: "GET, HEAD" },
      status: 405,
    });
  }
  if (
    !config.waitlistActivationEnabled ||
    config.recaptchaSiteKey === undefined ||
    recaptcha === undefined
  ) {
    return apiJson({ error: "waitlist verification is not available" }, request, config, {
      headers: { "Cache-Control": "no-store" },
      status: 503,
    });
  }
  const response = apiJson(
    {
      actions: { confirm: WAITLIST_CONFIRM_ACTION, join: WAITLIST_JOIN_ACTION },
      siteKey: config.recaptchaSiteKey,
    },
    request,
    config,
    { headers: { "Cache-Control": "no-store" }, status: 200 },
  );
  return request.method === "HEAD" ? withoutBody(response) : response;
}

async function handleWaitlistConfirm(
  request: Request,
  url: URL,
  config: RuntimeConfig,
  store: WaitlistStore,
  quota: WaitlistQuota,
  rateLimiter: InMemoryRateLimiter,
  dispatcher: { verifyEmailLink: IdentityPlatformClient["verifyEmailLink"] } | undefined,
  codec: Pick<
    WaitlistConfirmationCodec,
    "openBrowserProof" | "openLink" | "sealBrowserProof"
  > | undefined,
  recaptcha: Pick<RecaptchaEnterpriseClient, "assess"> | undefined,
  identitySecrets: readonly Uint8Array[],
  now: () => Date,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withSecurityHeaders(
      new Response(null, { headers: corsHeaders(request, config), status: 204 }),
    );
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return apiJson({ error: "method not allowed" }, request, config, {
      headers: { Allow: "GET, POST, OPTIONS" },
      status: 405,
    });
  }
  if (
    !config.waitlistActivationEnabled ||
    dispatcher === undefined ||
    codec === undefined ||
    recaptcha === undefined
  ) {
    return apiJson({ error: "waitlist verification is not available" }, request, config, {
      status: 503,
    });
  }

  const nowMs = now().getTime();
  if (request.method === "GET") {
    // A mail scanner may follow this GET. It must never consume the code or
    // mutate waitlist state. The only effect is a short-lived, HttpOnly cookie
    // in that user agent, followed by a redirect that strips credentials from
    // the address bar and browser history.
    const linkState = url.searchParams.get("state") ?? "";
    const oobCode = url.searchParams.get("oobCode") ?? "";
    try {
      const proof = await codec.sealBrowserProof(linkState, oobCode, nowMs);
      return withSecurityHeaders(new Response(null, {
        headers: {
          "Cache-Control": "no-store",
          Location: "/waitlist/confirm",
          "Referrer-Policy": "no-referrer",
          "Set-Cookie": confirmationCookie(proof, 10 * 60),
        },
        status: 303,
      }));
    } catch {
      return withSecurityHeaders(new Response(null, {
        headers: {
          "Cache-Control": "no-store",
          Location: "/waitlist/confirm?result=invalid",
          "Referrer-Policy": "no-referrer",
          "Set-Cookie": clearConfirmationCookie(),
        },
        status: 303,
      }));
    }
  }

  const expectedOrigin = new URL(request.url).origin;
  if (request.headers.get("origin") !== expectedOrigin) {
    return apiJson({ error: "forbidden" }, request, config, {
      headers: { "Set-Cookie": clearConfirmationCookie() },
      status: 403,
    });
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return apiJson({ error: "expected application/json" }, request, config, {
      headers: { "Set-Cookie": clearConfirmationCookie() },
      status: 415,
    });
  }
  const parsed = await readBoundedJson(request, MAX_WAITLIST_BODY_SIZE);
  if (parsed.kind !== "ok") {
    return apiJson({ error: "invalid JSON body" }, request, config, {
      headers: { "Set-Cookie": clearConfirmationCookie() },
      status: parsed.kind === "too-large" ? 413 : 400,
    });
  }
  const recaptchaToken = (parsed.value as { recaptchaToken?: unknown } | undefined)?.recaptchaToken;
  if (typeof recaptchaToken !== "string") {
    return apiJson({ error: "verification is required" }, request, config, {
      headers: { "Set-Cookie": clearConfirmationCookie() },
      status: 400,
    });
  }

  const proofCookie = cookieValue(request.headers.get("cookie"), CONFIRMATION_COOKIE);
  const refuse = (status = 400): Response =>
    apiJson({ error: "verification link is invalid or has expired" }, request, config, {
      headers: { "Cache-Control": "no-store", "Set-Cookie": clearConfirmationCookie() },
      status,
    });
  if (proofCookie === undefined) return refuse();

  // Authenticate the server-minted browser proof before spending any shared
  // assessment or provider quota. An attacker with no mailbox-delivered link
  // can exercise bounded local cryptography, but cannot drain the budget that
  // legitimate confirmations need.
  let proof: { readonly linkState: string; readonly oobCode: string };
  let state: { readonly email: string };
  try {
    proof = await codec.openBrowserProof(proofCookie, nowMs);
    state = await codec.openLink(proof.linkState, nowMs);
  } catch {
    return refuse();
  }
  // This scope comes from the authenticated mailed proof, not from caller
  // input or a discardable browser cookie. One mailbox/link can therefore
  // consume only its own allowance and can never fill a shared gate used by
  // other people confirming their addresses.
  const confirmationQuotaSubject = sha256(state.email).slice(0, 32);

  const client = resolveWaitlistClient(request, identitySecrets);
  const local = rateLimiter.checkMany([
    {
      key: `waitlist:assessment-client:${client.id}`,
      limit: WAITLIST_QUOTA_LIMITS.client.limit,
      windowMs: 60_000,
    },
    {
      key: "waitlist:assessment-global",
      limit: WAITLIST_QUOTA_LIMITS.assessmentGlobal.limit,
      windowMs: 60_000,
    },
  ]);
  if (!local.allowed) {
    return apiJson({ error: "too many verification attempts" }, request, config, {
      headers: { "Retry-After": String(local.retryAfterSeconds) },
      status: 429,
    });
  }

  // Assessment spend and Identity Platform verification spend are separate.
  // Invalid bot tokens cannot consume the smaller provider budget.
  let decision;
  try {
    decision = await quota.consume([
      {
        key: "waitlist:assessment-global",
        limit: WAITLIST_QUOTA_LIMITS.assessmentGlobal.limit,
        windowSeconds: WAITLIST_QUOTA_LIMITS.assessmentGlobal.windowSeconds,
      },
      {
        key: `waitlist:assessment-confirmation:${confirmationQuotaSubject}`,
        limit: WAITLIST_QUOTA_LIMITS.assessmentSubject.limit,
        windowSeconds: WAITLIST_QUOTA_LIMITS.assessmentSubject.windowSeconds,
      },
    ], now());
  } catch {
    return apiJson({ error: "verification temporarily unavailable" }, request, config, {
      headers: { "Retry-After": "60" },
      status: 503,
    });
  }
  if (!decision.allowed) {
    return apiJson({ error: "too many verification attempts" }, request, config, {
      headers: { "Retry-After": String(decision.retryAfterSeconds) },
      status: 429,
    });
  }

  try {
    await recaptcha.assess(
      recaptchaToken,
      WAITLIST_CONFIRM_ACTION,
      nowMs,
      request.headers.get("user-agent") ?? undefined,
    );
  } catch (error) {
    console.error("waitlist confirmation attestation refused", error instanceof Error ? error.name : "unknown error");
    // The encrypted proof remains in its short-lived HttpOnly cookie so a
    // transient assessment failure does not destroy a valid mailed link.
    return apiJson({ error: "verification could not be completed" }, request, config, {
      status: 403,
    });
  }

  try {
    decision = await quota.consume([
      {
        key: "waitlist:confirm-global",
        limit: WAITLIST_QUOTA_LIMITS.global.limit,
        windowSeconds: WAITLIST_QUOTA_LIMITS.global.windowSeconds,
      },
      {
        key: `waitlist:confirm-subject:${confirmationQuotaSubject}`,
        limit: WAITLIST_QUOTA_LIMITS.client.limit,
        windowSeconds: WAITLIST_QUOTA_LIMITS.client.windowSeconds,
      },
    ], now());
  } catch {
    return apiJson({ error: "verification temporarily unavailable" }, request, config, {
      headers: { "Retry-After": "60" },
      status: 503,
    });
  }
  if (!decision.allowed) {
    return apiJson({ error: "too many verification attempts" }, request, config, {
      headers: { "Retry-After": String(decision.retryAfterSeconds) },
      status: 429,
    });
  }

  try {
    // Verify the OOB code before touching membership state. A caller without a
    // mailbox-delivered code can never choose a hash and time a database hit.
    const verifiedEmail = normalizeEmail(await dispatcher.verifyEmailLink(proof.oobCode, nowMs));
    if (verifiedEmail !== state.email) return refuse();

    const outcome = await store.confirm(
      sha256(verifiedEmail),
      sha256(`identity-platform-email-link:${verifiedEmail}`),
      nowMs,
    );
    if (outcome !== "confirmed" && outcome !== "already-confirmed") return refuse();
    return apiJson({ ok: true, status: "confirmed" }, request, config, {
      headers: { "Cache-Control": "no-store", "Set-Cookie": clearConfirmationCookie() },
      status: 200,
    });
  } catch (error) {
    console.error("waitlist confirmation refused", error instanceof Error ? error.name : "unknown error");
    return refuse();
  }
}

function confirmationCookie(value: string, maxAgeSeconds: number): string {
  return `${CONFIRMATION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

function clearConfirmationCookie(): string {
  return confirmationCookie("deleted", 0);
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const segment of header.split(";")) {
    const position = segment.indexOf("=");
    if (position < 1) continue;
    if (segment.slice(0, position).trim() === name) {
      const value = segment.slice(position + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
}

function withWaitlistClientCookie(response: Response, setCookie: string | undefined): Response {
  if (!setCookie) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", setCookie);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function rateLimitedWaitlistResponse(request: Request, config: RuntimeConfig, retryAfterSeconds = 60): Response {
  return apiJson(
    { error: "too many waitlist attempts" },
    request,
    config,
    { headers: { "Retry-After": String(retryAfterSeconds) }, status: 429 },
  );
}

function apiJson(body: unknown, request: Request, config: RuntimeConfig, options: JsonResponseOptions = {}): Response {
  const response = json(body, options);
  const headers = new Headers(response.headers);

  for (const [key, value] of corsHeaders(request, config)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function serveStatic(pathname: string, config: RuntimeConfig, headOnly = false): Promise<Response> {
  let pathnameWithoutSlash: string;
  try {
    pathnameWithoutSlash = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    return text("bad request", { status: 400 });
  }
  const requestedPath = pathnameWithoutSlash === "favicon.ico" ? "favicon.svg" : pathnameWithoutSlash;
  const normalizedPath = normalize(requestedPath);

  if (
    isAbsolute(normalizedPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith(`..${sep}`) ||
    normalizedPath.includes(`${sep}..${sep}`)
  ) {
    return text("not found", { status: 404 });
  }

  const resolved = await resolveStaticFile(config.publicDir, normalizedPath) ??
    (config.publicDir === BUILT_PUBLIC_DIR
      ? undefined
      : await resolveStaticFile(BUILT_PUBLIC_DIR, normalizedPath));
  if (resolved === undefined) {
    return text("not found", { status: 404 });
  }
  const file = Bun.file(resolved.path);
  // Touch Bun's own size metadata before wrapping its body in the common
  // security-header response. Without this, Bun treats the body as a generic
  // stream and may discard Content-Length in favour of chunked transfer.
  const fileSize = file.size;
  if (fileSize !== resolved.size) {
    return text("not found", { status: 404 });
  }

  return withSecurityHeaders(
    new Response(headOnly ? null : file, {
      headers: {
        "Cache-Control": normalizedPath === "waitlist-confirm.html"
          ? "no-store"
          : normalizedPath === "index.html" || normalizedPath === "scan.html"
          ? "no-cache"
          : "public, max-age=300",
        ...(normalizedPath === "waitlist-confirm.html" ? { "Referrer-Policy": "no-referrer" } : {}),
        "Content-Length": String(fileSize),
        "Content-Type": CONTENT_TYPES[extname(resolved.path)] ?? "application/octet-stream",
      },
    }),
  );
}

async function resolveStaticFile(
  root: string,
  normalizedPath: string,
): Promise<{ readonly path: string; readonly size: number } | undefined> {
  try {
    const realRoot = await realpath(root);
    const candidate = await realpath(join(realRoot, normalizedPath));
    const withinRoot = relative(realRoot, candidate);
    if (
      withinRoot === "" ||
      isAbsolute(withinRoot) ||
      withinRoot === ".." ||
      withinRoot.startsWith(`..${sep}`)
    ) {
      return undefined;
    }
    const metadata = await stat(candidate);
    return metadata.isFile() ? { path: candidate, size: metadata.size } : undefined;
  } catch {
    return undefined;
  }
}

function withoutBody(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.delete("Transfer-Encoding");

  return new Response(null, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

type BoundedJsonResult =
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" };

async function readBoundedJson(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      return { kind: "invalid" };
    }

    if (declaredBytes > maxBytes) {
      return { kind: "too-large" };
    }
  }

  if (!request.body) {
    return { kind: "invalid" };
  }

  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { kind: "ok", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { kind: "invalid" };
  }
}
