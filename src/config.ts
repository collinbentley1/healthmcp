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

  return {
    allowedHosts: parseList(env.ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    allowedOrigins: parseList(env.ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS),
    canonicalHost: env.CANONICAL_HOST ?? "medlock.ai",
    dataDir: env.DATA_DIR ?? join(import.meta.dir, "..", ".data"),
    deploymentEnvironment,
    firestoreCollection: env.FIRESTORE_COLLECTION ?? "waitlist",
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID ?? "(default)",
    firestoreProjectId: present(env.FIRESTORE_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT),
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

function parseBearerToken(value: string | undefined): string | undefined {
  const token = present(value);
  if (token && new TextEncoder().encode(token).byteLength < 32) {
    throw new Error("MEDLOCK_MCP_TOKEN must contain at least 32 bytes.");
  }

  return token;
}

function parseWaitlistBackend(value: string | undefined): RuntimeConfig["waitlistBackend"] {
  if (value === "firestore" || value === "memory") {
    return value;
  }

  return "file";
}
