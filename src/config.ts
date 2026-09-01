import { join } from "node:path";
import { Buffer } from "node:buffer";

export type RuntimeConfig = {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly canonicalHost: string;
  readonly dataDir: string;
  readonly deploymentEnvironment: "preview" | "production" | undefined;
  readonly firestoreCollection: string;
  readonly firestoreDatabaseId: string;
  readonly firestoreProjectId: string | undefined;
  // The Identity Platform project whose tokens this service will accept. Unset
  // means the ownership flow is not provisioned, and activation refuses rather
  // than guessing at an audience.
  readonly identityPlatformAudience: string | undefined;
  readonly identityPlatformContinueUrl: string | undefined;
  readonly legacyHosts: readonly string[];
  readonly mcpBearerToken: string | undefined;
  readonly port: number;
  readonly publicDir: string;
  readonly version: string;
  readonly waitlistBackend: "file" | "firestore" | "memory";
  readonly waitlistIdentitySecrets: readonly Uint8Array[];
};

const DEFAULT_ALLOWED_HOSTS = [
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "localhost",
  "medlock.ai",
  "www.medlock.ai",
  "mcp.medlock.ai",
  "healthmcp.ai",
  "www.healthmcp.ai",
  "healthmcp.app",
  "www.healthmcp.app",
  "*.run.app",
];

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "https://medlock.ai",
  "https://www.medlock.ai",
  "https://mcp.medlock.ai",
  "https://chat.openai.com",
  "https://claude.ai",
  "https://*.run.app",
];

const DEFAULT_LEGACY_HOSTS = ["healthmcp.ai", "www.healthmcp.ai", "healthmcp.app", "www.healthmcp.app"];
export const SOURCE_PUBLIC_DIR = join(import.meta.dir, "..", "public");
export const BUILT_PUBLIC_DIR = import.meta.dir.endsWith("/dist")
  ? join(import.meta.dir, "public")
  : join(import.meta.dir, "..", "dist", "public");

export function getRuntimeConfig(env: Record<string, string | undefined> = Bun.env): RuntimeConfig {
  const deploymentEnvironment = parseDeploymentEnvironment(env.PLATFORM_DEPLOY_ENVIRONMENT);
  const waitlistIdentitySecrets = parseWaitlistIdentitySecrets(env.WAITLIST_IDENTITY_KEYSET);
  const waitlistBackend = parseWaitlistBackend(env.WAITLIST_BACKEND);
  if ((deploymentEnvironment || waitlistBackend === "firestore") && waitlistIdentitySecrets.length === 0) {
    throw new Error("WAITLIST_IDENTITY_KEYSET is required for deployed services and the Firestore waitlist.");
  }
  // A deployed service runs many instances against shared state, and only the
  // Firestore backend offers a durable compare-and-swap. The file backend would
  // let two concurrent confirmations both succeed, so a deployment must say
  // Firestore explicitly rather than inherit a local default.
  if (deploymentEnvironment && waitlistBackend !== "firestore") {
    throw new Error(
      "A deployed service must set WAITLIST_BACKEND=firestore; no other backend has a durable compare-and-swap.",
    );
  }

  return {
    allowedHosts: parseList(env.ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    allowedOrigins: parseList(env.ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS),
    canonicalHost: env.CANONICAL_HOST ?? "medlock.ai",
    dataDir: env.DATA_DIR ?? join(import.meta.dir, "..", ".data"),
    deploymentEnvironment,
    firestoreCollection: env.FIRESTORE_COLLECTION ?? "waitlist",
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID ?? "(default)",
    firestoreProjectId: present(env.FIRESTORE_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT),
    identityPlatformAudience: parseIdentityAudience(env.IDENTITY_PLATFORM_AUDIENCE),
    identityPlatformContinueUrl: parseContinueUrl(env.IDENTITY_PLATFORM_CONTINUE_URL),
    legacyHosts: parseList(env.LEGACY_HOSTS, DEFAULT_LEGACY_HOSTS),
    mcpBearerToken: parseBearerToken(env.MEDLOCK_MCP_TOKEN),
    port: Number(env.PORT ?? 3000),
    publicDir: env.PUBLIC_DIR ?? (import.meta.dir.endsWith("/dist") ? BUILT_PUBLIC_DIR : SOURCE_PUBLIC_DIR),
    version: env.MEDLOCK_VERSION ?? "0.2.0",
    waitlistBackend,
    waitlistIdentitySecrets,
  };
}

function parseDeploymentEnvironment(
  value: string | undefined,
): RuntimeConfig["deploymentEnvironment"] {
  const environment = present(value);
  if (!environment) {
    return undefined;
  }
  if (environment === "preview" || environment === "production") {
    return environment;
  }
  throw new Error("PLATFORM_DEPLOY_ENVIRONMENT must be preview or production when configured.");
}

function parseWaitlistIdentitySecrets(value: string | undefined): Uint8Array[] {
  if (!value) {
    return [];
  }

  const encodedSecrets = value.split(",");
  if (encodedSecrets.length < 1 || encodedSecrets.length > 2 || new Set(encodedSecrets).size !== encodedSecrets.length) {
    throw new Error("WAITLIST_IDENTITY_KEYSET must contain one active key and at most one distinct prior key.");
  }

  return encodedSecrets.map((encoded) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
      throw new Error("WAITLIST_IDENTITY_KEYSET values must be unpadded base64url-encoded 32-byte keys.");
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encoded) {
      throw new Error("WAITLIST_IDENTITY_KEYSET values must use canonical base64url encoding.");
    }
    return Uint8Array.from(decoded);
  });
}

export function hostNameFromHeader(hostHeader: string | null): string {
  if (!hostHeader) {
    return "";
  }

  const normalized = hostHeader.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    const end = normalized.indexOf("]");
    return end === -1 ? normalized : normalized.slice(1, end);
  }

  return normalized.split(":")[0] ?? normalized;
}

export function normalizeOrigin(origin: string | null): string | undefined {
  if (!origin) {
    return undefined;
  }

  try {
    const url = new URL(origin);
    const normalized = url.origin.toLowerCase();
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      origin.toLowerCase() !== normalized
    ) {
      return undefined;
    }

    return normalized;
  } catch {
    return undefined;
  }
}

function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  if (!value) {
    return [...fallback];
  }

  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Where the sign-in link lands. This is a redirect target that Identity
// Platform will send to a mailbox, so it is validated rather than trusted: an
// attacker-supplied continue URL would turn the ownership mail into an open
// redirect carrying a single-use credential in its query string.
function parseContinueUrl(value: string | undefined): string | undefined {
  const raw = present(value);
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IDENTITY_PLATFORM_CONTINUE_URL must be an absolute URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("IDENTITY_PLATFORM_CONTINUE_URL must use https.");
  }
  // The oobCode arrives as a query parameter, so anything already carrying a
  // query or fragment is refused rather than merged with.
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new Error("IDENTITY_PLATFORM_CONTINUE_URL must not carry credentials, a query, or a fragment.");
  }
  return url.toString();
}

function parseIdentityAudience(value: string | undefined): string | undefined {
  const audience = present(value);
  if (audience === undefined) return undefined;
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(audience)) {
    throw new Error("IDENTITY_PLATFORM_AUDIENCE must be a Google Cloud project id.");
  }
  return audience;
}

function parseBearerToken(value: string | undefined): string | undefined {
  const token = present(value);
  if (token && new TextEncoder().encode(token).byteLength < 32) {
    throw new Error("MEDLOCK_MCP_TOKEN must contain at least 32 bytes.");
  }

  return token;
}

function parseWaitlistBackend(value: string | undefined): RuntimeConfig["waitlistBackend"] {
  // Unset means the local default. A value that is SET but unrecognised is a
  // misconfiguration, and silently falling back to the file backend would
  // quietly downgrade a deployment that meant to say "firestore" -- onto a
  // backend with no compare-and-swap, where the ownership flow is unsafe.
  if (value === undefined || value.trim() === "") return "file";
  if (value === "firestore" || value === "memory" || value === "file") return value;
  throw new Error("WAITLIST_BACKEND must be exactly firestore, memory, or file.");
}
