import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const [appArg] = Bun.argv.slice(2);
if (!appArg) {
  throw new Error("Usage: platform-verify.ts <application-root>");
}

const appRoot = await realpath(resolve(appArg));
const bunExecutable = process.execPath;
if (process.platform !== "linux") {
  throw new Error("Privileged application verification requires Linux /proc executable pinning.");
}
// App checks execute caller-controlled code. Referencing the runner by its
// writable pathname would let an early check atomically replace Bun and forge
// every later result. Linux keeps this link bound to the already-loaded inode
// even if the original pathname is renamed or replaced.
const immutableBunExecutable = `/proc/${process.pid}/exe`;
const tscEntrypoint = join(appRoot, "node_modules/typescript/bin/tsc");
const forbiddenBunShim = join(appRoot, "node_modules/.bin/bun");

await requireRegularFile(join(appRoot, "tools/format.ts"), "tools/format.ts");
await requireRegularFile(join(appRoot, "tools/lint.ts"), "tools/lint.ts");
await requireRegularFile(join(appRoot, "tools/build.ts"), "tools/build.ts");
await requireRegularFile(tscEntrypoint, "the pinned TypeScript compiler entrypoint");

if (await lstat(forbiddenBunShim).catch(() => undefined)) {
  throw new Error("Dependencies must not install a node_modules/.bin/bun executable shadow.");
}

const verificationEnvironment = { ...process.env };
verificationEnvironment.PATH = [dirname(bunExecutable), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
for (const name of [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "DHI_ACCESS_TOKEN",
  "DHI_USERNAME",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_TOKEN",
  "SOCKET_API_KEY",
  "SOCKET_API_TOKEN",
]) {
  delete verificationEnvironment[name];
}

const commands: Array<[string, string[]]> = [
  // Type-check first. Later app-owned format/lint/test/build helpers must not
  // get an opportunity to replace the reviewed compiler before it executes.
  [
    "typecheck",
    [immutableBunExecutable, "--no-env-file", "--no-orphans", tscEntrypoint, "--noEmit"],
  ],
  [
    "format check",
    [
      immutableBunExecutable,
      "--no-env-file",
      "--no-orphans",
      join(appRoot, "tools/format.ts"),
      "--check",
    ],
  ],
  [
    "lint",
    [immutableBunExecutable, "--no-env-file", "--no-orphans", join(appRoot, "tools/lint.ts")],
  ],
  ["test", [immutableBunExecutable, "--no-env-file", "--no-orphans", "test"]],
  [
    "build",
    [immutableBunExecutable, "--no-env-file", "--no-orphans", join(appRoot, "tools/build.ts")],
  ],
];

for (const [label, command] of commands) {
  console.log(`Running trusted ${label} command...`);
  const child = Bun.spawn(command, {
    cwd: appRoot,
    env: verificationEnvironment,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}.`);
  }
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symbolic-link file.`);
  }
}
