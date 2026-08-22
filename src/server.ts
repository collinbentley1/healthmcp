import { extname, join, normalize } from "node:path";
import { BUILT_PUBLIC_DIR, getRuntimeConfig, type RuntimeConfig } from "./config.ts";
import { corsHeaders, json, shouldRedirectToCanonical, text, withSecurityHeaders, type JsonResponseOptions } from "./http.ts";
import { createMcpEndpoint, type McpEndpoint } from "./mcp.ts";
import { InMemoryRateLimiter, type RateLimitRule } from "./rate-limit.ts";
import {
  createWaitlistIdentitySecret,
  resolveWaitlistClient,
} from "./waitlist-client.ts";
import { createWaitlistStore, submitWaitlist, type WaitlistStore } from "./waitlist.ts";

type ServerDependencies = {
  readonly config?: RuntimeConfig;
  readonly mcpEndpoint?: McpEndpoint;
  readonly now?: () => Date;
  readonly rateLimiter?: InMemoryRateLimiter;
  readonly waitlistIdentitySecrets?: readonly Uint8Array[];
  readonly waitlistStore?: WaitlistStore;
};

export const MAX_REQUEST_BODY_SIZE = 1_048_576;
const MAX_WAITLIST_BODY_SIZE = 8_192;
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
  const waitlistStore = dependencies.waitlistStore ?? createWaitlistStore(config);
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
          rateLimiter,
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
  rateLimiter: InMemoryRateLimiter,
  identitySecrets: readonly Uint8Array[],
  now: () => Date,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withSecurityHeaders(new Response(null, { headers: corsHeaders(request, config), status: 204 }));
  }

  if (request.method !== "POST") {
    return apiJson({ error: "method not allowed" }, request, config, { headers: { Allow: "POST, OPTIONS" }, status: 405 });
  }

  const client = resolveWaitlistClient(request, identitySecrets);
  const respond = (response: Response): Response => withWaitlistClientCookie(response, client.setCookie);

  const rules: RateLimitRule[] = [
    { key: `waitlist:client:${client.id}`, limit: 5, windowMs: 60_000 },
    { key: "waitlist:global", limit: 60, windowMs: 60_000 },
  ];
  if (!client.authenticated) {
    rules.unshift({ key: "waitlist:unestablished", limit: 5, windowMs: 60_000 });
  }
  const decision = rateLimiter.checkMany(rules);
  if (!decision.allowed) {
    const response = rateLimitedWaitlistResponse(request, config, decision.retryAfterSeconds);
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
    return respond(apiJson({ error: result.error }, request, config, { status: result.status }));
  }

  return respond(apiJson({ duplicate: result.duplicate, ok: true }, request, config, { status: 202 }));
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
