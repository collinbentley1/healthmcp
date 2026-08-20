import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const failures: string[] = [];

await requireContains("Dockerfile", "dhi.io/bun", "Dockerfile must use Docker Hardened Bun images.");
await requireContains("Dockerfile", "bun-v1.4.0", "Dockerfile must pin Bun 1.4.0.");
await requireContains("public/index.html", 'rel="icon"', "The document must link a favicon.");
await requireContains("tools/build.ts", "scan.html", "The production build must include the scan handoff page.");
await requireContains("src/mcp.ts", "WebStandardStreamableHTTPServerTransport", "MCP must use the web-standard Streamable HTTP transport.");
await rejectContains("public/index.html", "https://", "The frontend should not load third-party assets.");
await rejectContains("public/assets/styles.css", "@import", "Styles should not import third-party design libraries.");
await rejectContains("src/client.ts", "react", "The frontend should stay framework-free.");
await rejectContains("src/server.ts", "wrangler", "Cloudflare/Wrangler runtime code should not remain.");
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
