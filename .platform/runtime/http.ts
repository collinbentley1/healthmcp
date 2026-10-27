import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function readJson(request: Request, maximumBytes = 65_536): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Expected application/json.");
  }
  const text = await readText(request, maximumBytes);
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON."); }
}

export async function readText(request: Pick<Request, "headers" | "body">, maximumBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Invalid body bound.");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
    throw new HttpError(413, "Request body is too large.");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw new HttpError(413, "Request body is too large."); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid request body.");
  } finally { reader.releaseLock(); }
}

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...Object.fromEntries(new Headers(headers)) } });
}

export function requireOrigin(request: Request, origin: string): void {
  if (new URL(request.url).host !== new URL(origin).host || request.headers.get("origin") !== origin) {
    throw new HttpError(403, "Request origin is not allowed.");
  }
}

export type HttpOptions = {
  readonly origin?: string;
  readonly csp?: string;
  readonly permissionsPolicy?: string;
  readonly log?: (entry: Readonly<Record<string, string | number>>) => void;
};

export function secureHandler(handler: (request: Request) => Response | Promise<Response>, options: HttpOptions = {}) {
  return async (request: Request): Promise<Response> => {
    const id = crypto.randomUUID();
    const start = performance.now();
    let response: Response;
    try { response = await handler(request); }
    catch (error) {
      response = error instanceof HttpError
        ? json({ error: error.message, requestId: id }, error.status)
        : json({ error: "Internal server error.", requestId: id }, 500);
    }
    let method = "UNKNOWN"; let https = false;
    try { method = request.method; https = Boolean(Bun.env.K_SERVICE) || new URL(options.origin ?? request.url).protocol === "https:"; } catch {}
    let headers = response.headers;
    const defaults = {
      "Content-Security-Policy": options.csp ?? "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
      "Permissions-Policy": options.permissionsPolicy ?? "camera=(), microphone=(), geolocation=(), payment=()",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    };
    const apply = () => {
      for (const [key, value] of Object.entries(defaults)) if (!headers.has(key)) headers.set(key, value);
      if (https && !headers.has("Strict-Transport-Security")) headers.set("Strict-Transport-Security", "max-age=31536000");
      headers.set("X-Request-ID", id);
      if (/^[a-f0-9]{40}$/.test(Bun.env.PLATFORM_SOURCE_SHA ?? "") && /^[a-f0-9]{40}$/.test(Bun.env.PLATFORM_RELEASE_SHA ?? "")) { headers.set("X-Platform-Source", Bun.env.PLATFORM_SOURCE_SHA!); headers.set("X-Platform-Release", Bun.env.PLATFORM_RELEASE_SHA!); }
    };
    try { apply(); } catch { response = new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) }); headers = response.headers; apply(); }
    options.log?.({ requestId: id, method, status: response.status, durationMs: Math.round(performance.now() - start) });
    // Preserve Bun.file bodies so their framing and sendfile behavior survive middleware.
    return method === "HEAD" && response.body !== null ? new Response(null, { status: response.status, statusText: response.statusText, headers }) : response;
  };
}

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

export async function serveStatic(directory: string, pathname: string): Promise<Response> {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, "Invalid path."); }
  if (decoded.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.split("/").includes("..")) throw new HttpError(400, "Invalid path.");
  const root = await realpath(directory);
  const path = resolve(root, decoded === "/" ? "index.html" : decoded.replace(/^\/+/, ""));
  if (!path.startsWith(root + sep)) throw new HttpError(404, "Not found.");
  let canonical: string;
  try { canonical = await realpath(path); } catch { throw new HttpError(404, "Not found."); }
  if (!canonical.startsWith(root + sep) || !(await stat(canonical)).isFile()) throw new HttpError(404, "Not found.");
  return new Response(Bun.file(canonical), { headers: {
    "Content-Type": contentTypes[extname(canonical)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  } });
}

export async function boundedFetch(url: string | URL, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  return fetch(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
}
