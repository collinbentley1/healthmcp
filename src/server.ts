import { extname, join, normalize } from "node:path";
import { BUILT_PUBLIC_DIR, getRuntimeConfig, type RuntimeConfig } from "./config.ts";
import { corsHeaders, json, shouldRedirectToCanonical, text, withSecurityHeaders, type JsonResponseOptions } from "./http.ts";
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
import { IdentityTokenVerifier } from "./identity-token.ts";
import { createWaitlistStore, normalizeEmail, sha256, submitWaitlist, type WaitlistStore } from "./waitlist.ts";

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
  readonly identityVerifier?: { verify: IdentityTokenVerifier["verify"] };
};

export const MAX_REQUEST_BODY_SIZE = 1_048_576;
const MAX_WAITLIST_BODY_SIZE = 8_192;

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

// The authoritative buckets. `unestablished` is what makes cookie minting
// pointless: discarding a cookie to get a fresh client id moves the request
// into a bucket that is shared by everyone doing the same thing.
// The three original budgets are unchanged; moving them to Firestore is the
// fix, not relaxing them. `email` is new: it bounds how often one address can
// be submitted, which is what stops the endpoint being used to send repeated
// confirmation mail to someone who never asked for it.
export const WAITLIST_QUOTA_LIMITS = {
  client: { limit: 5, windowSeconds: 60 },
  email: { limit: 3, windowSeconds: 3_600 },
  global: { limit: 60, windowSeconds: 60 },
  unestablished: { limit: 5, windowSeconds: 60 },
} as const;
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
  // Absent audience means the ownership flow is not provisioned. Activation
  // then refuses outright rather than constructing a verifier that would trust
  // an audience nobody configured.
  const identityVerifier = dependencies.identityVerifier ??
    (config.identityPlatformAudience === undefined
      ? undefined
      : new IdentityTokenVerifier({ audience: config.identityPlatformAudience }));
  const rateLimiter = dependencies.rateLimiter ?? new InMemoryRateLimiter();
  const mcpEndpoint = dependencies.mcpEndpoint ?? createMcpEndpoint(config);
  const now = dependencies.now ?? (() => new Date());
  const waitlistIdentitySecrets =
    dependencies.waitlistIdentitySecrets ??
    (config.waitlistIdentitySecrets.length > 0
      ? config.waitlistIdentitySecrets
      : [createWaitlistIdentitySecret()]);

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
          waitlistIdentitySecrets,
          now,
          sleep,
          monotonicNow,
        );
      }

      if (url.pathname === "/api/waitlist/activate") {
        return await handleWaitlistActivation(
          request,
          config,
          waitlistStore,
          waitlistQuota,
          identityVerifier,
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

  const client = resolveWaitlistClient(request, identitySecrets);
  const respond = (response: Response): Response => withWaitlistClientCookie(response, client.setCookie);

  // Defence in depth, not the limit. This sheds an obvious flood before the
  // request costs a network round trip, but it is per-instance and so can never
  // be the thing that decides.
  const localRules: RateLimitRule[] = [
    { key: `waitlist:client:${client.id}`, limit: WAITLIST_QUOTA_LIMITS.client.limit, windowMs: 60_000 },
    { key: "waitlist:global", limit: WAITLIST_QUOTA_LIMITS.global.limit, windowMs: 60_000 },
  ];
  if (!client.authenticated) {
    localRules.unshift({
      key: "waitlist:unestablished",
      limit: WAITLIST_QUOTA_LIMITS.unestablished.limit,
      windowMs: 60_000,
    });
  }
  const local = rateLimiter.checkMany(localRules);
  if (!local.allowed) {
    const response = rateLimitedWaitlistResponse(request, config, local.retryAfterSeconds);
    return client.authenticated ? respond(response) : response;
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

  const body = parsedBody.value as { email?: unknown; source?: unknown } | undefined;
  if (!body || typeof body.email !== "string") {
    return respond(apiJson({ error: "email is required" }, request, config, { status: 400 }));
  }

  // The authoritative decision, shared by every instance. The per-address
  // bucket is keyed by the hash, never the address, so the quota collection
  // holds no readable email even for an operator.
  const quotaRules: QuotaRule[] = [
    {
      key: "waitlist:global",
      limit: WAITLIST_QUOTA_LIMITS.global.limit,
      windowSeconds: WAITLIST_QUOTA_LIMITS.global.windowSeconds,
    },
    {
      key: `waitlist:email:${sha256(normalizeEmail(body.email)).slice(0, 32)}`,
      limit: WAITLIST_QUOTA_LIMITS.email.limit,
      windowSeconds: WAITLIST_QUOTA_LIMITS.email.windowSeconds,
    },
  ];
  quotaRules.push(
    client.authenticated
      ? {
        key: `waitlist:client:${client.id.toLowerCase()}`,
        limit: WAITLIST_QUOTA_LIMITS.client.limit,
        windowSeconds: WAITLIST_QUOTA_LIMITS.client.windowSeconds,
      }
      : {
        key: "waitlist:unestablished",
        limit: WAITLIST_QUOTA_LIMITS.unestablished.limit,
        windowSeconds: WAITLIST_QUOTA_LIMITS.unestablished.windowSeconds,
      },
  );

  let decision;
  try {
    decision = await quota.consume(quotaRules, now());
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
    return client.authenticated ? respond(response) : response;
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

  const result = await submitWaitlist(
    store,
    {
      email: body.email,
      clientId: client.id,
      source: typeof body.source === "string" ? body.source : "site",
      userAgent: request.headers.get("user-agent") ?? undefined,
    },
    now(),
  );

  if (!result.ok) {
    return await settle(apiJson({ error: result.error }, request, config, { status: result.status }));
  }

  // `result.outcome` is deliberately not read. Whether this created a pending
  // entry or found one already there is internal state; publishing it is the
  // enumeration oracle, whether it is published as a body field, a status code,
  // a header, or a message on the page.
  return await settle(apiJson({ ok: true }, request, config, { status: 202 }));
}

// Activation: the second half of the ownership flow.
//
// It accepts a token and nothing else. There is no browser API key anywhere in
// this design, so there is no client-callable Identity Platform surface to
// bypass the quota with -- the only way to reach a mailbox is through the
// backend dispatch, behind the same shared budget.
async function handleWaitlistActivation(
  request: Request,
  config: RuntimeConfig,
  store: WaitlistStore,
  quota: WaitlistQuota,
  verifier: { verify: IdentityTokenVerifier["verify"] } | undefined,
  identitySecrets: readonly Uint8Array[],
  now: () => Date,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withSecurityHeaders(
      new Response(null, { headers: corsHeaders(request, config), status: 204 }),
    );
  }
  if (request.method !== "POST") {
    return apiJson({ error: "method not allowed" }, request, config, {
      headers: { Allow: "POST, OPTIONS" },
      status: 405,
    });
  }
  if (verifier === undefined) {
    // Fail closed: no audience configured means no token can be trusted, and
    // an activation that cannot verify must not activate.
    return apiJson({ error: "waitlist activation is not available" }, request, config, {
      status: 503,
    });
  }

  const client = resolveWaitlistClient(request, identitySecrets);
  // Activation spends the shared budget too. Otherwise it would be an
  // unmetered oracle for guessing tokens.
  let decision;
  try {
    decision = await quota.consume([
      {
        key: "waitlist:global",
        limit: WAITLIST_QUOTA_LIMITS.global.limit,
        windowSeconds: WAITLIST_QUOTA_LIMITS.global.windowSeconds,
      },
      client.authenticated
        ? {
          key: `waitlist:client:${client.id.toLowerCase()}`,
          limit: WAITLIST_QUOTA_LIMITS.client.limit,
          windowSeconds: WAITLIST_QUOTA_LIMITS.client.windowSeconds,
        }
        : {
          key: "waitlist:unestablished",
          limit: WAITLIST_QUOTA_LIMITS.unestablished.limit,
          windowSeconds: WAITLIST_QUOTA_LIMITS.unestablished.windowSeconds,
        },
    ], now());
  } catch (error) {
    console.error("waitlist quota unavailable", error instanceof Error ? error.name : "unknown");
    return apiJson({ error: "waitlist temporarily unavailable" }, request, config, {
      headers: { "Retry-After": "60" },
      status: 503,
    });
  }
  if (!decision.allowed) {
    return rateLimitedWaitlistResponse(request, config, decision.retryAfterSeconds);
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return apiJson({ error: "expected application/json" }, request, config, { status: 415 });
  }
  const parsed = await readBoundedJson(request, MAX_WAITLIST_BODY_SIZE);
  if (parsed.kind === "too-large") {
    return apiJson({ error: "request body too large" }, request, config, { status: 413 });
  }
  if (parsed.kind !== "ok") {
    return apiJson({ error: "invalid JSON body" }, request, config, { status: 400 });
  }
  const body = parsed.value as { idToken?: unknown } | undefined;
  if (!body || typeof body.idToken !== "string") {
    return apiJson({ error: "idToken is required" }, request, config, { status: 400 });
  }

  const nowMs = now().getTime();
  let identity;
  try {
    identity = await verifier.verify(body.idToken, nowMs);
  } catch {
    // Deliberately uniform: which check refused the token is not the caller's
    // business, and naming it would help an attacker shape the next one.
    return apiJson({ error: "activation could not be verified" }, request, config, { status: 401 });
  }

  const outcome = await store.confirm(sha256(identity.email), identity.subject, nowMs);
  if (outcome === "absent" || outcome === "expired") {
    // Same answer for both: whether an address was ever submitted, and whether
    // its pending window lapsed, are membership facts.
    return apiJson({ error: "activation could not be verified" }, request, config, { status: 401 });
  }
  // "confirmed" and "already-confirmed" are the same to a caller: a replayed
  // token must not be distinguishable from a first use.
  return apiJson({ ok: true }, request, config, { status: 200 });
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

  if (normalizedPath.startsWith("..") || normalizedPath.includes("/../")) {
    return text("not found", { status: 404 });
  }

  let filePath = join(config.publicDir, normalizedPath);
  let file = Bun.file(filePath);

  if (!(await file.exists()) && config.publicDir !== BUILT_PUBLIC_DIR) {
    filePath = join(BUILT_PUBLIC_DIR, normalizedPath);
    file = Bun.file(filePath);
  }

  if (!(await file.exists())) {
    return text("not found", { status: 404 });
  }

  return withSecurityHeaders(
    new Response(headOnly ? null : file, {
      headers: {
        "Cache-Control": normalizedPath === "index.html" || normalizedPath === "scan.html" ? "no-cache" : "public, max-age=300",
        "Content-Length": String(file.size),
        "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      },
    }),
  );
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
