import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { boundedFetch, HttpError, readText } from "./http.ts";
import type { Identity } from "./auth.ts";

export type Account = Identity & { emailVerified: boolean; authenticatedAt: number };
export interface IdentityProvider {
  verify(token: string): Promise<Account>;
  signIn(email: string, password: string): Promise<string>;
  signUp(email: string, password: string): Promise<string>;
  sendVerification(token: string): Promise<void>;
  sendReset(email: string): Promise<void>;
  revoke(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
class ProviderError extends HttpError {
  constructor(readonly code: string, status: number) { super(status >= 500 ? 503 : status === 429 ? 429 : 400, "Unable to complete this account request."); }
}

// Google owns password storage, email delivery, action codes, disabled-user and
// revocation checks. No provider credentials or refresh tokens reach the browser.
export function managedIdentity(projectId: string, apiKey: string, continueUrl?: string): IdentityProvider {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !apiKey) throw new Error("Identity configuration is required.");
  const emulator = Bun.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator && (Bun.env.K_SERVICE || Bun.env.NODE_ENV === "production" || !projectId.startsWith("demo-") || !/^(127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(emulator))) throw new Error("Identity emulation is restricted to local tests.");
  const app = getApps().find(app => app.name === projectId) ?? initializeApp({ projectId, ...(emulator ? {} : { credential: applicationDefault() }) }, projectId);
  const auth = getAuth(app);
  const base = emulator ? `http://${emulator}/identitytoolkit.googleapis.com/v1` : "https://identitytoolkit.googleapis.com/v1";
  const call = async (method: string, body: unknown): Promise<Record<string, unknown>> => {
    const result = await boundedFetch(`${base}/accounts:${method}?key=${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!result.ok) {
      const value = JSON.parse(await readText(result, 4096)) as {error?:{message?:string}};
      const code = value.error?.message?.split(/[ :]/)[0] ?? "UNKNOWN";
      throw new ProviderError(code, result.status);
    }
    return JSON.parse(await readText(result, 65_536)) as Record<string, unknown>;
  };
  const credentials = async (method: string, email: string, password: string) => {
    const value = await call(method, { email, password, returnSecureToken: true });
    if (typeof value.idToken !== "string") throw new HttpError(503, "Sign in is unavailable.");
    return value.idToken;
  };
  return {
    async verify(token) {
      try {
        if (token.length > 16_384) throw new Error("Invalid token.");
        const claims = await auth.verifyIdToken(token, true);
        return { id: claims.uid, ...(claims.email ? { email: claims.email } : {}), emailVerified: claims.email_verified === true, authenticatedAt: claims.auth_time };
      } catch(error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code && !["auth/argument-error", "auth/invalid-argument", "auth/invalid-id-token", "auth/id-token-expired", "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found"].includes(code)) throw new HttpError(503, "Sign in is temporarily unavailable.");
        throw new HttpError(401, "Sign in required.");
      }
    },
    signIn: (email, password) => credentials("signInWithPassword", email, password),
    signUp: (email, password) => credentials("signUp", email, password),
    async sendVerification(token) { await call("sendOobCode", { requestType: "VERIFY_EMAIL", idToken: token, ...(continueUrl ? { continueUrl } : {}) }); },
    async sendReset(email) { try { await call("sendOobCode", { requestType: "PASSWORD_RESET", email, ...(continueUrl ? { continueUrl } : {}) }); } catch (error) { if (!(error instanceof ProviderError && error.code === "EMAIL_NOT_FOUND")) throw error; } },
    async revoke(id) { await auth.revokeRefreshTokens(id); },
    async remove(id) { await auth.deleteUser(id); },
  };
}
