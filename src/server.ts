import { extname, join, normalize } from "node:path";
import { BUILT_PUBLIC_DIR, getRuntimeConfig, type RuntimeConfig } from "./config.ts";
import { corsHeaders, json, shouldRedirectToCanonical, text, withSecurityHeaders, type JsonResponseOptions } from "./http.ts";
import { createMcpEndpoint, type McpEndpoint } from "./mcp.ts";
import { InMemoryRateLimiter } from "./rate-limit.ts";
import { createWaitlistStore, submitWaitlist, type WaitlistStore } from "./waitlist.ts";

type ServerDependencies = {
  readonly config?: RuntimeConfig;
  readonly mcpEndpoint?: McpEndpoint;
  readonly now?: () => Date;
  readonly rateLimiter?: InMemoryRateLimiter;
  readonly waitlistStore?: WaitlistStore;
};

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

  return async function handleRequest(request: Request): Promise<Response> {
    const healthUrl = new URL(request.url);
    if (healthUrl.pathname === "/livez") {
      return Response.json({ ok: true });
    }

    const canonicalRedirect = shouldRedirectToCanonical(request, config);
    if (canonicalRedirect) {
      return withSecurityHeaders(new Response(null, { headers: { Location: canonicalRedirect.href }, status: 308 }));
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/waitlist") {
        return handleWaitlist(request, config, waitlistStore, rateLimiter, now);
      }

      if (url.pathname === "/api/mcp") {
        return mcpEndpoint.handle(request);
      }

      if (url.pathname === "/scan") {
        return serveStatic("/scan.html", config);
      }

      return serveStatic(url.pathname, config);
    } catch (error) {
      console.error("request failed", error);
      return json({ error: "internal server error" }, { status: 500 });
    }
  };
}

export const handleRequest = createHandler();

if (import.meta.main) {
  const config = getRuntimeConfig();
  const server = Bun.serve({
    fetch: createHandler({ config }),
    hostname: "0.0.0.0",
    port: config.port,
  });

  console.info(`medlock listening on ${server.url}`);
}

async function handleWaitlist(
  request: Request,
  config: RuntimeConfig,
  store: WaitlistStore,
  rateLimiter: InMemoryRateLimiter,
  now: () => Date,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(request, config), status: 204 });
  }

  if (request.method !== "POST") {
    return apiJson({ error: "method not allowed" }, request, config, { headers: { Allow: "POST, OPTIONS" }, status: 405 });
  }

  const ipAddress = clientAddress(request);
  const decision = rateLimiter.check(`waitlist:${ipAddress}`, 5, 60_000);
  if (!decision.allowed) {
    return apiJson(
      { error: "too many waitlist attempts" },
      request,
      config,
      { headers: { "Retry-After": String(decision.retryAfterSeconds ?? 60) }, status: 429 },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return apiJson({ error: "expected application/json" }, request, config, { status: 415 });
  }

  const body = (await request.json().catch(() => undefined)) as { email?: unknown; source?: unknown } | undefined;
  if (!body || typeof body.email !== "string") {
    return apiJson({ error: "email is required" }, request, config, { status: 400 });
  }

  const result = await submitWaitlist(
    store,
    {
      email: body.email,
      ipAddress,
      source: typeof body.source === "string" ? body.source : "site",
      userAgent: request.headers.get("user-agent") ?? undefined,
    },
    now(),
  );

  if (!result.ok) {
    return apiJson({ error: result.error }, request, config, { status: result.status });
  }

  return apiJson(
    {
      duplicate: result.duplicate,
      ok: true,
    },
    request,
    config,
    { status: result.duplicate ? 200 : 201 },
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

async function serveStatic(pathname: string, config: RuntimeConfig): Promise<Response> {
  const pathnameWithoutSlash = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
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
    new Response(file, {
      headers: {
        "Cache-Control": normalizedPath === "index.html" || normalizedPath === "scan.html" ? "no-cache" : "public, max-age=300",
        "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      },
    }),
  );
}

function clientAddress(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip") || "unknown";
}
