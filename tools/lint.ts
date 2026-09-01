import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const failures: string[] = [];

await requireContains(
  "Dockerfile",
  "FROM platform.invalid/bun-release AS bun-release",
  "Dockerfile must retain the platform-injected Bun release base.",
);
await requireContains(
  "Dockerfile",
  "FROM platform.invalid/dhi-bun-dev AS deps",
  "Dockerfile must retain the platform-injected DHI development base.",
);
await requireContains(
  "Dockerfile",
  "FROM platform.invalid/dhi-bun-runtime AS runtime",
  "Dockerfile must retain the platform-injected DHI runtime base.",
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
  "rateLimiter.checkMany(localRules)",
  "Waitlist client, establishment, and global rate limits must commit atomically.",
);
// The in-process limiter above is per-instance and so can only ever be a first
// pass. The decision that actually bounds abuse is the shared one, and it has
// to be a single atomic call for the same reason the local one does.
// `expiresAt` is inert until a TTL policy names it. The opportunistic delete in
// the quota only retires buckets that receive another request, so an abandoned
// per-address bucket -- the kind bulk abuse creates -- would otherwise live
// forever, and an unverified pending entry would never actually expire.
for (const collection of ["waitlist", "waitlist_quota"]) {
  await requireContains(
    "infra/terraform/prod/main.tf",
    `collection = "${collection}"`,
    `The ${collection} collection must have a Firestore TTL policy.`,
  );
}
await requireContains(
  "infra/terraform/prod/main.tf",
  "ttl_config {}",
  "Firestore TTL must be configured on the expiresAt field, not merely written into documents.",
);

await requireContains(
  "src/server.ts",
  "quota.consume(quotaRules, now())",
  "The authoritative waitlist quota must commit every bucket in one atomic call.",
);
await requireContains(
  "src/waitlist.ts",
  'flag: "wx"',
  "The file waitlist store must create-if-absent rather than read then write.",
);
await requireContains(
  "src/firestore.ts",
  "response.status === 409",
  "Firestore waitlist creation must let the server decide existence, via 409.",
);
// F-02. Whether an address was already present is internal state. Publishing it
// anywhere a caller can see -- a body field, a status, a header, or a message on
// the page -- rebuilds the enumeration oracle.
await rejectContains(
  "src/server.ts",
  "duplicate",
  "The waitlist response must not disclose whether an address was already present.",
);
await rejectContains(
  "src/client.ts",
  "duplicate",
  "The waitlist form must not disclose whether an address was already present.",
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
