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

// Firestore's reaper only acts on values stored as timestamps. A field written
// as a string is ignored outright -- no error and no deletion -- so a policy
// could be perfectly configured and still bound nothing.
await requireContains(
  "src/waitlist.ts",
  "expiresAt: { timestampValue: entry.expiresAt }",
  "expiresAt must be stored as a timestamp; Firestore TTL ignores string values.",
);
await requireContains(
  "src/waitlist-quota.ts",
  "expiresAt: {\n                    timestampValue:",
  "Quota buckets must store expiresAt as a timestamp; Firestore TTL ignores string values.",
);
// Terraform declaring a policy is not the same as the database enforcing one.
// The gate below reads the live field configuration back, and is the only
// thing that tells those two states apart.
await requireContains(
  "package.json",
  '"verify:ttl"',
  "A live TTL verification gate must remain wired into the project's scripts.",
);

// Ownership confirmation stays server-side and keyless. A browser-visible API
// key would turn the Google mail surface into an attacker-controlled relay.
for (
  const path of [
    "src/config.ts",
    "src/identity-platform.ts",
    "src/server.ts",
    "infra/terraform/prod/main.tf",
  ]
) {
  for (const forbidden of ["key=", "apiKey", "api_key", "browser_key", "google_apikeys_key"]) {
    await rejectContains(
      path,
      forbidden,
      "No Identity Platform API key may appear anywhere in the ownership flow.",
    );
  }
}
await requireContains(
  "src/identity-platform.ts",
  "/accounts:sendOobCode",
  "Confirmation dispatch must use the project-scoped admin sendOobCode endpoint.",
);
await requireContains(
  "src/identity-platform.ts",
  "v1/projects/${",
  "Confirmation dispatch must address the project-scoped endpoint.",
);
await requireContains(
  "src/identity-platform.ts",
  "/v1/accounts:resetPassword",
  "OOB ownership verification must use the documented OAuth check-only endpoint.",
);
await requireContains(
  "src/identity-platform.ts",
  'result.requestType !== "EMAIL_SIGNIN"',
  "Only EMAIL_SIGNIN OOB codes may reach waitlist promotion.",
);
await rejectContains(
  "src/identity-platform.ts",
  "signInWithEmailLink(",
  "The API-key-required signInWithEmailLink method must remain absent.",
);
await requireContains(
  "src/identity-platform.ts",
  '"X-Goog-User-Project": this.#projectId',
  "OOB verification must bind OAuth quota and billing to the configured project.",
);
await requireContains(
  "src/identity-platform.ts",
  "const deadline = AbortSignal.timeout(this.#timeoutMs)",
  "Identity Platform token acquisition and API work must share one request deadline.",
);

// The state in the emailed link is encrypted and purpose-separated; scanners may
// follow GET without consuming the OOB code or mutating membership. Only the
// explicit, same-origin POST can verify and promote.
for (const needle of ["AES-GCM", "HKDF", "additionalData(purpose)"]) {
  await requireContains(
    "src/waitlist-confirmation.ts",
    needle,
    "Confirmation state must remain encrypted and purpose-separated.",
  );
}
for (const retiredRoute of ["/api/waitlist/challenge", "/api/waitlist/activate"]) {
  await rejectContains(
    "src/server.ts",
    retiredRoute,
    "The retired split challenge/activation surface must stay removed.",
  );
}
for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict"]) {
  await requireContains(
    "src/server.ts",
    attribute,
    "The short-lived browser proof cookie must retain all security attributes.",
  );
}
await requireOrderedBetween(
  "src/server.ts",
  "async function handleWaitlistConfirm(",
  "function confirmationCookie(",
  [
    'const proofCookie = cookieValue(',
    "proof = await codec.openBrowserProof(",
    "state = await codec.openLink(",
    'key: "waitlist:assessment-global"',
    "await recaptcha.assess(",
    'key: "waitlist:confirm-global"',
    "await dispatcher.verifyEmailLink(",
    "await store.confirm(",
  ],
  "Confirmation must authenticate the mailed proof and bot before spending provider quota or touching membership.",
);
await requireOrderedBetween(
  "src/server.ts",
  "async function handleWaitlist(",
  "function handleWaitlistConfig(",
  [
    "decision = await quota.consume(assessmentRules",
    "await recaptcha.assess(",
    "decision = await quota.consume(deliveryRules",
    "await submitWaitlist(",
    "await dispatcher.sendSignInLink(",
  ],
  "Join must spend assessment budget, attest, spend delivery budget, store, and dispatch in that order.",
);
await rejectContains(
  "src/server.ts",
  "result.outcome",
  "Storage membership outcomes must never influence the public response.",
);
await requireContains(
  "src/config.ts",
  'waitlistActivationEnabled && waitlistBackend !== "firestore"',
  "An enabled ownership flow must require the durable Firestore CAS backend.",
);
await requireContains(
  "src/config.ts",
  'url.pathname !== "/api/waitlist/confirm"',
  "The Identity Platform return URL must be the exact canonical confirmation endpoint.",
);

// Bot proof is project-scoped, action-bound, hostname-bound, fresh, and scored.
for (const needle of [
  "recaptchaenterprise.googleapis.com/v1/projects/",
  "properties?.valid !== true",
  "properties.action !== expectedAction",
  "!this.#allowedHostnames.has(hostname)",
  "score < this.#minimumScore",
]) {
  await requireContains(
    "src/recaptcha.ts",
    needle,
    "reCAPTCHA Enterprise assessment validation must remain fail closed.",
  );
}

// The public site key is created in the same reviewed plan, never copied from a
// dashboard or secret. Terraform and the backend each enforce a narrower part
// of the trust boundary: score-key/domain settings at Google, exact project,
// site-key, action, hostname, freshness, and score in the application.
for (const needle of [
  'resource "google_recaptcha_enterprise_key" "waitlist"',
  'deletion_policy = "PREVENT"',
  'integration_type  = "SCORE"',
  'allow_all_domains = false',
  'allow_amp_traffic = false',
  'allowed_domains   = ["medlock.ai"]',
  "RECAPTCHA_SITE_KEY = google_recaptcha_enterprise_key.waitlist.name",
]) {
  await requireContains(
    "infra/terraform/prod/main.tf",
    needle,
    "The reCAPTCHA score key must remain managed, canonical-domain-bound, and wired by resource identity.",
  );
}
await requireContains(
  "infra/terraform/bootstrap/main.tf",
  '"recaptchaenterprise.googleapis.com"',
  "The reviewed bootstrap must enable the reCAPTCHA Enterprise API.",
);
for (const forbidden of [
  "allow_all_domains = true",
  "testing_options",
  "testing_score",
  "testing_challenge",
]) {
  await rejectContains(
    "infra/terraform/prod/main.tf",
    forbidden,
    "Production reCAPTCHA must not use unrestricted domains or deterministic test behavior.",
  );
}
await rejectContains(
  "infra/terraform/prod/main.tf",
  "WAITLIST_ACTIVATION_ENABLED",
  "Activation must remain absent until the protected infrastructure apply and live mailbox proof succeed.",
);

await requireContains(
  "src/waitlist.ts",
  'flag: "wx"',
  "The file waitlist store must create-if-absent rather than read then write.",
);
for (const needle of [
  "await this.#client.beginTransaction(deadline)",
  "await this.#client.batchGet([name], transaction, deadline)",
  "verify: name",
  'outcome = "refreshed"',
]) {
  await requireContains(
    "src/waitlist.ts",
    needle,
    "Waitlist preparation must use one fixed Firestore transaction shape and refresh expired claims.",
  );
}
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

async function requireOrderedBetween(
  path: string,
  start: string,
  end: string,
  needles: readonly string[],
  message: string,
): Promise<void> {
  const text = await readFile(join(root, path), "utf8");
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0) {
    failures.push(`${path}: ${message}`);
    return;
  }
  const section = text.slice(startAt, endAt);
  let cursor = 0;
  for (const needle of needles) {
    const at = section.indexOf(needle, cursor);
    if (at < 0) {
      failures.push(`${path}: ${message}`);
      return;
    }
    cursor = at + needle.length;
  }
}
