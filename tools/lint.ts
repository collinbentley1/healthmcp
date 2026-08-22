import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const failures: string[] = [];

await requireContains("Dockerfile", "dhi.io/bun", "Dockerfile must use Docker Hardened Bun images.");
await requireContains(
  "Dockerfile",
  "FROM oven/bun:1.4.0-alpine@sha256:",
  "Dockerfile must pin Bun 1.4.0 by digest.",
);
await requireContains("public/index.html", 'rel="icon"', "The document must link a favicon.");
await requireContains("tools/build.ts", "scan.html", "The production build must include the scan handoff page.");
await requireContains("src/mcp.ts", "createMcpHandler", "MCP must use the SDK's per-request HTTP handler factory.");
await rejectContains("package.json", "@modelcontextprotocol/inspector", "The vulnerable Inspector dependency tree must stay absent.");
await rejectExternalReferences("public/index.html", "https://medlock.ai/", "The frontend should not reference third-party assets.");
await rejectContains("public/assets/styles.css", "@import", "Styles should not import third-party design libraries.");
await rejectContains("src/client.ts", "react", "The frontend should stay framework-free.");
await rejectContains("src/server.ts", "wrangler", "Cloudflare/Wrangler runtime code should not remain.");
await rejectContains(
  "src/server.ts",
  ".requestIP(",
  "Cloud Run proxy sockets must not identify waitlist clients.",
);
await rejectContains(
  "src/server.ts",
  "x-forwarded-for",
  "Caller-controlled forwarding headers must not identify waitlist clients.",
);
await requireContains(
  "src/waitlist-client.ts",
  "createHmac",
  "Waitlist client cookies must be authenticated.",
);
await requireContains(
  "src/waitlist-client.ts",
  "timingSafeEqual",
  "Waitlist cookie authentication must compare signatures in constant time.",
);
await requireContains(
  "src/server.ts",
  "rateLimiter.checkMany(rules)",
  "Waitlist client, establishment, and global rate limits must commit atomically.",
);
await requireContains(
  "src/config.ts",
  "WAITLIST_IDENTITY_KEYSET is required for deployed services and the Firestore waitlist",
  "Deployed waitlist cookies must use stable environment-scoped signing secrets.",
);
await rejectContains("package.json", "next", "Next.js should not remain in the pure Bun runtime.");

await import("./verify-socket-config.ts");

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

async function requireContains(path: string, needle: string, message: string): Promise<void> {
  const text = await readFile(join(root, path), "utf8");
  if (!text.includes(needle)) {
    failures.push(`${path}: ${message}`);
  }
}

async function rejectContains(path: string, needle: string, message: string): Promise<void> {
  const text = await readFile(join(root, path), "utf8");
  if (text.includes(needle)) {
    failures.push(`${path}: ${message}`);
  }
}

async function rejectExternalReferences(path: string, sameOriginPrefix: string, message: string): Promise<void> {
  const text = await readFile(join(root, path), "utf8");
  if (text.replaceAll(sameOriginPrefix, "").includes("https://")) {
    failures.push(`${path}: ${message}`);
  }
}
