// Post-deploy gate: does the database actually reap what the service marks?
//
// This reads the live Firestore field configuration and fails unless every
// collection the service writes has an ACTIVE TTL policy on `expiresAt`. It is
// read-only -- the single permission it needs is datastore.indexes.get -- so it
// is safe to run from a low-privilege identity, and it is the only thing that
// distinguishes "TTL is configured in Terraform" from "TTL is enforced".
//
// Run: bun run tools/verify-ttl.ts
import {
  describeTtlState,
  TTL_FIELD,
  ttlCollections,
  ttlPolicyIsEnforced,
  ttlStateFromField,
  type TtlPolicyReport,
} from "../src/ttl-policy.ts";

const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? "";
const databaseId = process.env.FIRESTORE_DATABASE ?? "(default)";
const baseCollection = process.env.FIRESTORE_COLLECTION ?? "waitlist";

if (projectId.length === 0) {
  console.error("GOOGLE_CLOUD_PROJECT must be set.");
  process.exit(2);
}

// Never printed, never logged, never placed in a URL.
async function accessToken(): Promise<string> {
  const supplied = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (supplied !== undefined && supplied.length > 0) {
    return supplied;
  }
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) {
    throw new Error(`metadata token request failed: ${response.status}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

async function inspect(token: string, collection: string): Promise<TtlPolicyReport> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${
    encodeURIComponent(databaseId).replaceAll("%28", "(").replaceAll("%29", ")")
  }/collectionGroups/${encodeURIComponent(collection)}/fields/${encodeURIComponent(TTL_FIELD)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 403) {
    return {
      collection,
      detail: "read denied; the caller lacks datastore.indexes.get",
      state: "unreadable",
    };
  }
  if (!response.ok) {
    return { collection, detail: `field read failed: ${response.status}`, state: "unreadable" };
  }
  const state = ttlStateFromField(await response.json());
  return { collection, detail: describeTtlState(state), state };
}

const token = await accessToken();
const reports = await Promise.all(
  ttlCollections(baseCollection).map((collection) => inspect(token, collection)),
);

for (const report of reports) {
  const mark = ttlPolicyIsEnforced(report.state) ? "ok  " : "FAIL";
  console.log(`${mark} ${report.collection}.${TTL_FIELD}: ${report.detail}`);
}

const failed = reports.filter((report) => !ttlPolicyIsEnforced(report.state));
if (failed.length > 0) {
  console.error(
    `\n${failed.length} collection(s) have no enforced TTL. Documents accumulate without bound.`,
  );
  process.exit(1);
}
console.log("\nAll declared TTL policies are active.");
