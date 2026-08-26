// Canonical dependency-free adapter for Socket's public PURL API.
// Keep this byte-identical to the app template. Organization policy is enforced
// independently by required checks from the installed Socket GitHub App.
const socketFirewallBase = "https://firewall-api.socket.dev/purl";
const reviewedPackageLimit = 128;
const publicConcurrency = 10;
const requestTimeoutMs = 30_000;
const maxResponseBytes = 10 * 1024 * 1024;
const maxAlertsPerArtifact = 256;
const maxAlertTextLength = 4_096;
const userAgent = "collinbentley-platform-bun-scanner/1.0";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Logger = (message: string) => void;

type SocketScannerOptions = {
  readonly fetcher?: Fetcher;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
};

type SocketArtifact = {
  readonly alerts: readonly unknown[];
  readonly inputPurl: string;
};

type JsonRecord = Record<string, unknown>;

export function createSocketScanner(options: SocketScannerOptions = {}): Bun.Security.Scanner {
  const fetcher = options.fetcher ?? fetch;
  const logger = options.logger ?? console.log;
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  return {
    version: "1",
    async scan({ packages }) {
      if (packages.length > reviewedPackageLimit) {
        throw new Error(
          `Socket Security Scanner: refusing to scan ${packages.length} packages; the reviewed limit is ${reviewedPackageLimit}`,
        );
      }

      const purls = packagePurls(packages);
      if (purls.length === 0) {
        return [];
      }

      const artifacts = await scanPublic(purls, fetcher, logger, timeoutMs);
      return artifacts.flatMap(artifactToAdvisories);
    },
  };
}

export const scanner = createSocketScanner();

function packagePurls(packages: readonly Bun.Security.Package[]): string[] {
  const purls = new Set<string>();
  for (const pkg of packages) {
    if (
      typeof pkg.name !== "string" ||
      typeof pkg.version !== "string" ||
      pkg.name.length === 0 ||
      pkg.version.length === 0 ||
      pkg.name.length > 214 ||
      pkg.version.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(pkg.name) ||
      /[\u0000-\u001f\u007f]/.test(pkg.version)
    ) {
      throw new Error("Socket Security Scanner: Bun supplied an invalid package identity");
    }
    purls.add(`pkg:npm/${pkg.name}@${pkg.version}`);
  }
  return [...purls];
}

async function scanPublic(
  purls: readonly string[],
  fetcher: Fetcher,
  logger: Logger,
  timeoutMs: number,
): Promise<SocketArtifact[]> {
  logger("Socket Security Scanner free mode.");
  const artifacts: SocketArtifact[] = [];
  for (const batch of chunk(purls, publicConcurrency)) {
    const responses = await Promise.all(
      batch.map(async (purl) => {
        const text = await requestText(
          fetcher,
          `${socketFirewallBase}/${encodeURIComponent(purl)}`,
          {
            headers: { Accept: "application/x-ndjson", "User-Agent": userAgent },
          },
          maxResponseBytes,
          "public package policy request",
          timeoutMs,
        );
        return parseCompleteArtifacts(text, [purl], false);
      }),
    );
    artifacts.push(...responses.flat());
  }
  return artifacts;
}

async function requestText(
  fetcher: Fetcher,
  input: string,
  init: RequestInit,
  limit: number,
  label: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetcher(input, { ...init, redirect: "error", signal: controller.signal });
    } catch (error) {
      throw new Error(`Socket Security Scanner: ${label} failed`, { cause: error });
    }
    requireOk(response, label);
    try {
      return await readLimitedBody(response, limit, `${label} response`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Socket Security Scanner:")) {
        throw error;
      }
      throw new Error(`Socket Security Scanner: ${label} failed`, { cause: error });
    }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) {
    return requestTimeoutMs;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > requestTimeoutMs) {
    throw new Error("Socket Security Scanner: invalid request timeout");
  }
  return value;
}

async function readLimitedBody(response: Response, limit: number, label: string): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > limit) {
      throw new Error(`Socket Security Scanner: ${label} exceeds the size limit`);
    }
  }

  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Socket Security Scanner: ${label} exceeds the size limit`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const value of chunks) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Socket Security Scanner: ${label} is not valid UTF-8`);
  }
}

function parseCompleteArtifacts(
  text: string,
  expectedPurls: readonly string[],
  requireSummary: boolean,
): SocketArtifact[] {
  const remaining = new Set(expectedPurls);
  const artifacts: SocketArtifact[] = [];
  let summarySeen = false;

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Socket Security Scanner: package policy returned invalid NDJSON");
    }
    if (!isRecord(parsed)) {
      throw new Error("Socket Security Scanner: package policy returned an invalid row");
    }

    if (parsed._type === "purlError") {
      throw new Error("Socket Security Scanner: package policy could not resolve a requested package");
    }
    if (parsed._type === "summary") {
      if (!requireSummary || summarySeen || !validSummary(parsed.value, expectedPurls.length)) {
        throw new Error("Socket Security Scanner: package policy returned an invalid summary");
      }
      summarySeen = true;
      continue;
    }
    if (parsed._type !== undefined) {
      throw new Error("Socket Security Scanner: package policy returned an unknown row type");
    }
    if (typeof parsed.inputPurl !== "string" || !Array.isArray(parsed.alerts)) {
      throw new Error("Socket Security Scanner: package policy returned an invalid artifact");
    }
    if (parsed.alerts.length > maxAlertsPerArtifact) {
      throw new Error("Socket Security Scanner: package policy returned too many alerts");
    }
    if (!remaining.delete(parsed.inputPurl)) {
      throw new Error("Socket Security Scanner: package policy returned an unexpected artifact");
    }
    artifacts.push({ inputPurl: parsed.inputPurl, alerts: parsed.alerts });
  }

  if (remaining.size > 0) {
    throw new Error(
      `Socket Security Scanner: package policy omitted ${remaining.size} requested artifact(s)`,
    );
  }
  if (requireSummary && !summarySeen) {
    throw new Error("Socket Security Scanner: package policy omitted its completion summary");
  }
  return artifacts;
}

function validSummary(value: unknown, expected: number): boolean {
  if (!isRecord(value) || !isRecord(value.errors)) {
    return false;
  }
  const errors = value.errors;
  return (
    value.purl_input === expected &&
    value.resolved === expected &&
    errors.purl_malformed === 0 &&
    errors.purl_ecosystem_not_enabled === 0 &&
    errors.package_not_found === 0
  );
}

function artifactToAdvisories(artifact: SocketArtifact): Bun.Security.Advisory[] {
  return artifact.alerts.map((rawAlert) => {
    if (
      !isRecord(rawAlert) ||
      (rawAlert.action !== "error" && rawAlert.action !== "warn") ||
      typeof rawAlert.type !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(rawAlert.type) ||
      rawAlert.type === "pendingScan" ||
      rawAlert.type === "notFound"
    ) {
      throw new Error("Socket Security Scanner: package policy returned an invalid alert");
    }
    if (rawAlert.props !== undefined && !isRecord(rawAlert.props)) {
      throw new Error("Socket Security Scanner: package policy returned invalid alert properties");
    }
    if (rawAlert.fix !== undefined && !isRecord(rawAlert.fix)) {
      throw new Error("Socket Security Scanner: package policy returned an invalid alert fix");
    }
    const properties = isRecord(rawAlert.props) ? rawAlert.props : {};
    const fix = isRecord(rawAlert.fix) ? rawAlert.fix : {};
    const description: string[] = [];
    const alternatePackage = optionalAlertText(properties.alternatePackage);
    const policyDescription = optionalAlertText(properties.description);
    const policyNote = optionalAlertText(properties.note);
    const fixDescription = optionalAlertText(fix.description);

    if (rawAlert.type === "didYouMean" && alternatePackage !== undefined) {
      description.push(`This package could be a typo-squatting attempt of ${alternatePackage}.`);
    }
    if (policyDescription !== undefined) {
      description.push(policyDescription);
    }
    if (policyNote !== undefined) {
      description.push(policyNote);
    }
    if (fixDescription !== undefined) {
      description.push(`Fix: ${fixDescription}`);
    }
    if (description.length === 0) {
      description.push(`Socket policy alert: ${rawAlert.type}.`);
    }

    return {
      level: rawAlert.action === "error" ? "fatal" : "warn",
      package: artifact.inputPurl,
      url: packageOverviewUrl(artifact.inputPurl),
      description: `${description.join("\n\n")}\n`,
    };
  });
}

function packageOverviewUrl(purl: string): string {
  const prefix = "pkg:npm/";
  if (!purl.startsWith(prefix)) {
    return "https://socket.dev/";
  }
  const body = purl.slice(prefix.length);
  const separator = body.lastIndexOf("@");
  if (separator < 1 || separator === body.length - 1) {
    return "https://socket.dev/";
  }
  const name = body.slice(0, separator);
  const version = body.slice(separator + 1);
  const encodedName = name.split("/").map(encodeURIComponent).join("/");
  return `https://socket.dev/npm/package/${encodedName}/overview/${encodeURIComponent(version)}`;
}

function requireOk(response: Response, label: string): void {
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retry = retryAfter && /^\d+$/.test(retryAfter) ? `; retry after ${retryAfter}s` : "";
    throw new Error(`Socket Security Scanner: ${label} received HTTP ${response.status}${retry}`);
  }
}

function validTimestamp(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalAlertText(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length > maxAlertTextLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Socket Security Scanner: package policy returned invalid alert text");
  }
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("::", ": :")
    .replaceAll("##[", "# #[");
}
