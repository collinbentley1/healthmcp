import { lstat } from "node:fs/promises";

type PackageJson = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

type Bunfig = {
  readonly install?: {
    readonly security?: {
      readonly scanner?: string;
    };
  };
};

const expectedScanner = "./tools/socket-security-scanner.ts";
const forbiddenPublishedScanner = "@socketsecurity/bun-security-scanner";
const bunfig = Bun.TOML.parse(await Bun.file("bunfig.toml").text()) as Bunfig;
const packageJson = (await Bun.file("package.json").json()) as PackageJson;
const scanner = bunfig.install?.security?.scanner;
const scannerMetadata = await lstat(expectedScanner).catch(() => undefined);

if (scanner !== expectedScanner) {
  console.error(`bunfig.toml must set [install.security] scanner = "${expectedScanner}".`);
  process.exit(1);
}

if (!scannerMetadata?.isFile() || scannerMetadata.isSymbolicLink()) {
  console.error(`${expectedScanner} must be a regular, non-symbolic-link file.`);
  process.exit(1);
}

if (
  [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ].some((dependencies) => Object.hasOwn(dependencies ?? {}, forbiddenPublishedScanner))
) {
  console.error(`package.json must not include ${forbiddenPublishedScanner}.`);
  process.exit(1);
}

export {};
