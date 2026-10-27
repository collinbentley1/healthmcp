import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { boundedFetch, readText, HttpError } from "./http.ts";

export type Identity = { readonly id: string; readonly email?: string };
const keyUrl = new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
const googleKeys = createRemoteJWKSet(keyUrl, { timeoutDuration: 5000 });

export function identityVerifier(projectId: string, keys: JWTVerifyGetKey = googleKeys) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error("Invalid identity project.");
  return async (token: string): Promise<Identity> => {
    try {
      if (token.length > 16_384) throw new Error("Token too large.");
      const { payload } = await jwtVerify(token, keys, {
        issuer: `https://securetoken.google.com/${projectId}`, audience: projectId, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "auth_time"],
      });
      const now = Math.floor(Date.now() / 1000);
      if (!payload.sub || payload.sub.length > 128 || typeof payload.auth_time !== "number" || payload.auth_time > now || (payload.iat ?? Infinity) > now) throw new Error("Invalid identity claims.");
      return { id: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
    } catch { throw new HttpError(401, "Sign in required."); }
  };
}

export function sessionToken(request: Request, origin?: string): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  const name = new URL(origin ?? request.url).protocol === "https:" ? "__Host-platform-session" : "platform-session";
  const values = cookie.split(";").map(part => part.trim()).filter(part => part.startsWith(name + "="));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_.-]{1,16384}$/.test(value) ? value : undefined;
}

export function sessionCookie(origin: string, token: string, maxAge: number): string {
  const url = new URL(origin);
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Sessions require HTTPS.");
  if (!/^[A-Za-z0-9_.-]*$/.test(token) || token.length > 16_384 || !Number.isInteger(maxAge) || maxAge < 0 || maxAge > 3600) throw new Error("Invalid session.");
  return `${secure ? "__Host-platform-session" : "platform-session"}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export async function passwordSignIn(apiKey: string, email: string, password: string): Promise<string> {
  if (!apiKey || email.length > 254 || password.length > 1024) throw new HttpError(400, "Invalid credentials.");
  const result = await boundedFetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!result.ok) throw new HttpError(401, "Unable to sign in.");
  const body = JSON.parse(await readText(result, 65_536)) as { idToken?: unknown };
  if (typeof body.idToken !== "string") throw new HttpError(503, "Sign in is unavailable.");
  return body.idToken;
}
