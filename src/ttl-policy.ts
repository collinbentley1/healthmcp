// Firestore TTL, as a checkable fact rather than a declared intention.
//
// Writing `expiresAt` into a document does nothing on its own. Firestore only
// reaps a document when a TTL policy names that field on that collection
// group, and the policy is a property of the database rather than of anything
// this service deploys. So the service can be entirely correct and still
// accumulate records forever, which is why the live state is read back and
// checked rather than assumed from the presence of the field.
//
// A further detail that makes this worth verifying rather than eyeballing:
// TTL acts only on values Firestore stores as timestamps. A field written as a
// string is silently ignored by the reaper -- no error, no deletion.

export const TTL_FIELD = "expiresAt";

// Both collections the service writes carry `expiresAt`, and both need the
// policy. Derived from the configured base name so the check cannot drift away
// from what the service actually uses.
export function ttlCollections(baseCollection: string): readonly string[] {
  return [baseCollection, `${baseCollection}_quota`];
}

export type TtlPolicyState =
  | "active"
  | "creating"
  | "needs-repair"
  | "absent"
  | "unreadable";

export type TtlPolicyReport = {
  readonly collection: string;
  readonly detail: string;
  readonly state: TtlPolicyState;
};

// Maps the Firestore Admin field resource onto a verdict. The shape is the one
// the live API returns: a field with no policy simply has no `ttlConfig` key,
// which is exactly the state this project is in until the policy is applied.
export function ttlStateFromField(field: unknown): TtlPolicyState {
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    return "unreadable";
  }
  const ttlConfig = (field as { ttlConfig?: unknown }).ttlConfig;
  if (ttlConfig === undefined) {
    return "absent";
  }
  if (typeof ttlConfig !== "object" || ttlConfig === null || Array.isArray(ttlConfig)) {
    return "unreadable";
  }
  const state = (ttlConfig as { state?: unknown }).state;
  if (state === "ACTIVE") return "active";
  if (state === "CREATING") return "creating";
  if (state === "NEEDS_REPAIR") return "needs-repair";
  // A ttlConfig with no state at all is not evidence of an active policy.
  return "unreadable";
}

// Only "active" counts. "creating" is not yet reaping anything and
// "needs-repair" means Firestore gave up part way through, so treating either
// as success would report a bound that is not being enforced.
export function ttlPolicyIsEnforced(state: TtlPolicyState): boolean {
  return state === "active";
}

export function describeTtlState(state: TtlPolicyState): string {
  switch (state) {
    case "active":
      return "policy is active and reaping expired documents";
    case "creating":
      return "policy exists but is still building; nothing is being reaped yet";
    case "needs-repair":
      return "policy is in NEEDS_REPAIR; Firestore is not reaping reliably";
    case "absent":
      return "no TTL policy names this field, so expiresAt is inert";
    case "unreadable":
      return "field configuration could not be interpreted";
  }
}
