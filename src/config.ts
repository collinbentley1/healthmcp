import { join } from "node:path";

export type RuntimeConfig = {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly canonicalHost: string;
  readonly dataDir: string;
  readonly firestoreCollection: string;
  readonly firestoreDatabaseId: string;
  readonly firestoreProjectId: string | undefined;
  readonly legacyHosts: readonly string[];
  readonly mcpBearerToken: string | undefined;
  readonly port: number;
  readonly publicDir: string;
  readonly version: string;
  readonly waitlistBackend: "file" | "firestore" | "memory";
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
  return {
    allowedHosts: parseList(env.ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    allowedOrigins: parseList(env.ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS),
    canonicalHost: env.CANONICAL_HOST ?? "medlock.ai",
    dataDir: env.DATA_DIR ?? join(import.meta.dir, "..", ".data"),
    firestoreCollection: env.FIRESTORE_COLLECTION ?? "waitlist",
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID ?? "(default)",
    firestoreProjectId: present(env.FIRESTORE_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT),
    legacyHosts: parseList(env.LEGACY_HOSTS, DEFAULT_LEGACY_HOSTS),
    mcpBearerToken: parseBearerToken(env.MEDLOCK_MCP_TOKEN),
    port: Number(env.PORT ?? 3000),
    publicDir: env.PUBLIC_DIR ?? (import.meta.dir.endsWith("/dist") ? BUILT_PUBLIC_DIR : SOURCE_PUBLIC_DIR),
    version: env.MEDLOCK_VERSION ?? "0.2.0",
    waitlistBackend: parseWaitlistBackend(env.WAITLIST_BACKEND),
  };
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
