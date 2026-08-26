import { hostNameFromHeader, normalizeOrigin, type RuntimeConfig } from "./config.ts";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export type JsonResponseOptions = {
  readonly headers?: HeadersInit;
  readonly status?: number;
};

export function json(body: unknown, options: JsonResponseOptions = {}): Response {
  return withSecurityHeaders(
    Response.json(body, {
      headers: {
        "Cache-Control": "no-store",
        ...options.headers,
      },
      status: options.status ?? 200,
    }),
  );
}

export function text(body: string, options: JsonResponseOptions = {}): Response {
  return withSecurityHeaders(
    new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        ...options.headers,
      },
      status: options.status ?? 200,
    }),
  );
}

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function shouldRedirectToCanonical(request: Request, config: RuntimeConfig): URL | undefined {
  const url = new URL(request.url);
  const host = hostNameFromHeader(request.headers.get("host")) || url.hostname.toLowerCase();
  const canonicalHost = config.canonicalHost.toLowerCase();

  if (host === canonicalHost) {
    return undefined;
  }

  if (config.legacyHosts.includes(host) || host === `www.${canonicalHost}`) {
    const target = new URL(request.url);
    target.protocol = "https:";
    target.host = canonicalHost;
    return target;
  }

  return undefined;
}

export function corsHeaders(request: Request, config: RuntimeConfig): Headers {
  const headers = new Headers();
  const origin = normalizeOrigin(request.headers.get("origin"));

  if (origin && matchesOrigin(origin, config.allowedOrigins)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, mcp-session-id");
  headers.set("Access-Control-Expose-Headers", "MCP-Protocol-Version, mcp-session-id");
  headers.set("Access-Control-Max-Age", "600");
  return headers;
}

export function withCors(response: Response, request: Request, config: RuntimeConfig): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(request, config)) {
    headers.set(key, value);
  }

  return withSecurityHeaders(
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
}

export function isTrustedHost(request: Request, config: RuntimeConfig): boolean {
  const url = new URL(request.url);
  const host = hostNameFromHeader(request.headers.get("host")) || url.hostname.toLowerCase();
  return matchesHost(host, config.allowedHosts);
}

export function isTrustedOrigin(request: Request, config: RuntimeConfig): boolean {
  const originHeader = request.headers.get("origin");
  if (originHeader === null) {
    return true;
  }

  const origin = normalizeOrigin(originHeader);
  return origin !== undefined && matchesOrigin(origin, config.allowedOrigins);
}

function matchesHost(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      return host.endsWith(pattern.slice(1));
    }

    return host === pattern;
  });
}

function matchesOrigin(origin: string, patterns: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  return patterns.some((pattern) => {
    if (pattern.includes("*.")) {
      const patternUrl = new URL(pattern.replace("*.", "wildcard."));
      return (
        parsed.protocol === patternUrl.protocol &&
        parsed.port === patternUrl.port &&
        matchesHost(parsed.hostname, [patternUrl.hostname.replace("wildcard.", "*.")])
      );
    }

    return origin === pattern;
  });
}
