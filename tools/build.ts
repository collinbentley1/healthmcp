import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const distDir = join(import.meta.dir, "..", "dist");
const publicDir = join(import.meta.dir, "..", "public");
const distPublicDir = join(distDir, "public");

await rm(distDir, { force: true, recursive: true });
await mkdir(join(distPublicDir, "assets"), { recursive: true });

const clientBuild = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "src", "client.ts")],
  minify: true,
  naming: "assets/client.js",
  outdir: distPublicDir,
  sourcemap: "external",
  target: "browser",
});

assertBuild(clientBuild, "client");

const serverBuild = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "src", "server.ts")],
  minify: false,
  outdir: distDir,
  sourcemap: "external",
  target: "bun",
});

assertBuild(serverBuild, "server");

await Bun.write(join(distPublicDir, "index.html"), Bun.file(join(publicDir, "index.html")));
await Bun.write(join(distPublicDir, "scan.html"), Bun.file(join(publicDir, "scan.html")));
await Bun.write(join(distPublicDir, "favicon.svg"), Bun.file(join(publicDir, "favicon.svg")));
await Bun.write(join(distPublicDir, "assets", "styles.css"), Bun.file(join(publicDir, "assets", "styles.css")));
await Bun.write(join(distPublicDir, "assets", "og-image.png"), Bun.file(join(publicDir, "assets", "og-image.png")));

function assertBuild(result: Bun.BuildOutput, label: string): void {
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }

    throw new Error(`${label} build failed`);
  }
}
