import { RateLimiterMemory } from "rate-limiter-flexible";
import { HttpError, json, readJson, requireOrigin, secureHandler, serveStatic } from "./http.ts";
import { sessionCookie, sessionToken } from "./auth.ts";
import type { Account, IdentityProvider } from "./identity.ts";
import type { RecordStore } from "./data.ts";

export type ApplicationConfig = { origin: string; publicDirectory: string; development: boolean; preview?: boolean; nonce?: string };
export type ApplicationDependencies = { store: RecordStore; identity?: IdentityProvider };
type Handler = (request: Request, identify: () => Promise<Account>) => Promise<Response | undefined>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function application(config: ApplicationConfig, dependencies: ApplicationDependencies, handler: Handler) {
  const origin = new URL(config.origin).origin;
  if (config.development && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Development authentication requires a loopback origin.");
  const shared = new RateLimiterMemory({ points: 120, duration: 60 });
  const accountLimit = new RateLimiterMemory({ points: 5, duration: 60 });
  const consume = async (key: string) => {
    try { await shared.consume("application"); await accountLimit.consume(key); }
    catch { throw new HttpError(429, "Too many requests. Try again in a minute."); }
  };
  return secureHandler(async request => {
    const url = new URL(request.url);
    if (url.pathname === "/livez") return json(config.nonce ? { ok: true, deployment: config.nonce } : { ok: true });
    if (url.pathname === "/readyz") { try { await dependencies.store.ready(); return json({ ok: true }); } catch { return json({ ok: false }, 503); } }
    if (url.host !== new URL(origin).host) throw new HttpError(403, "Host is not allowed.");
    if (!["GET", "HEAD"].includes(request.method)) requireOrigin(request, origin);
    const token = sessionToken(request, origin);
    let current: Promise<Account> | undefined;
    const identify = (): Promise<Account> => current ??= (async () => {
      if (config.preview) return { id: "synthetic-preview", emailVerified: true, authenticatedAt: Math.floor(Date.now() / 1000) };
      if (config.development && token === "development") return { id: "local-developer", email: "developer@example.invalid", emailVerified: true, authenticatedAt: Math.floor(Date.now() / 1000) };
      if (!token || !dependencies.identity) throw new HttpError(401, "Sign in required.");
      return dependencies.identity.verify(token);
    })();
    if (url.pathname === "/api/session" && request.method === "GET") return json({ user: await identify(), development: config.development, preview: Boolean(config.preview) });
    if (url.pathname === "/api/session" && request.method === "DELETE") return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(origin, "", 0) });
    if ((url.pathname === "/api/session" || url.pathname === "/api/account") && request.method === "POST") {
      const body = await readJson(request, 4096);
      if (!object(body) || typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || body.email.length > 254 || typeof body.password !== "string" || body.password.length > 1024 || body.password.length < (url.pathname === "/api/account" ? 12 : 1) || Object.keys(body).some(key => !["email", "password"].includes(key))) throw new HttpError(400, "Enter a valid email and password (at least 12 characters for a new account).");
      await consume(`login:${Bun.CryptoHasher.hash("sha256", body.email.toLowerCase(), "hex")}`);
      const identity = dependencies.identity;
      const signed = config.development ? "development" : !identity ? undefined : url.pathname === "/api/account" ? await identity.signUp(body.email, body.password) : await identity.signIn(body.email, body.password);
      if (!signed) throw new HttpError(503, "Sign in is unavailable.");
      if (!config.development) { await identity!.verify(signed); if (url.pathname === "/api/account") await identity!.sendVerification(signed); }
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(origin, signed, 3600) });
    }
    if (url.pathname === "/api/account/reset" && request.method === "POST") {
      const body = await readJson(request, 4096);
      if (!object(body) || typeof body.email !== "string" || body.email.length > 254) throw new HttpError(400, "Enter your email.");
      await consume(`reset:${Bun.CryptoHasher.hash("sha256", body.email.toLowerCase(), "hex")}`);
      if (!dependencies.identity) throw new HttpError(503, "Account recovery is unavailable.");
      await dependencies.identity.sendReset(body.email); return json({ ok: true });
    }
    if (url.pathname === "/api/account/verify" && request.method === "POST") {
      const user = await identify(); await consume(`verification:${user.id}`);
      if (!dependencies.identity || !token) throw new HttpError(503, "Verification is unavailable.");
      await dependencies.identity.sendVerification(token); return json({ ok: true });
    }
    if ((url.pathname === "/api/account" && request.method === "DELETE") || (url.pathname === "/api/session/revoke" && request.method === "POST")) {
      const user = await identify(); await consume(`account:${user.id}`);
      if (config.preview || config.development || !dependencies.identity) throw new HttpError(403, "Account management requires a managed identity.");
      const age = Math.floor(Date.now() / 1000) - user.authenticatedAt;
      if (!Number.isFinite(age) || age < 0 || age > 300) throw new HttpError(401, "Sign in again before changing your account.");
      if (url.pathname === "/api/account") { await dependencies.store.removeAll(user.id); await dependencies.identity.remove(user.id); }
      else { await Bun.sleep(Math.max(0, (user.authenticatedAt + 1) * 1000 - Date.now())); await dependencies.identity.revoke(user.id); }
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(origin, "", 0) });
    }
    const protectedIdentity = async () => { const user = await identify(); if (!user.emailVerified) throw new HttpError(403, "Verify your email, then sign in again."); if (!["GET", "HEAD"].includes(request.method)) { try { await shared.consume("writes"); } catch { throw new HttpError(429, "Too many requests. Try again in a minute."); } } return user; };
    const response = await handler(request, protectedIdentity);
    if (response) return response;
    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
    if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
    return serveStatic(config.publicDirectory, url.pathname);
  }, { origin, log: entry => console.info(JSON.stringify(entry)) });
}
