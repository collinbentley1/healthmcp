# Waitlist TTL: configured in code, NOT yet applied in the project

Date: 2026-09-01. Repository: collinbentley1/healthmcp. Branch:
security/waitlist-enumeration-and-global-quota.

## What is done

`infra/terraform/prod/main.tf` now declares real Firestore TTL policies for both
collections that carry an `expiresAt` field:

  google_firestore_field.waitlist_entry_ttl   collection "waitlist"        field expiresAt
  google_firestore_field.waitlist_quota_ttl   collection "waitlist_quota"  field expiresAt

Both use `ttl_config {}` (expire at the instant the field holds) and set
`index_config {}` explicitly, because an omitted `index_config` is not "leave
indexing alone" -- the provider treats an omitted block as a disable.

Provider support is confirmed at the pinned version. `terraform providers
schema -json` for hashicorp/google **7.45.0** reports `google_firestore_field`
with block types `index_config`, `ttl_config`, and `ttl_config.expiration_offset`
documented as an offset relative to the field's timestamp, omitted for none.

Validation: `terraform fmt -check` exit 0, `terraform validate` exit 0
("Success! The configuration is valid."). Repo lint now refuses a tree where
either collection loses its policy.

## What is NOT done, and why

**These resources cannot be applied by the protected pipeline as it stands.**

`google_firestore_field` is managed through the Firestore fields API, which is
governed by the `datastore.indexes.*` permission family. All five members exist
and are grantable in a project custom role -- from
`gcloud iam list-testable-permissions` against medlock-1025243085:

  datastore.indexes.create   customRolesSupportLevel=SUPPORTED  apiDisabled=false
  datastore.indexes.delete   customRolesSupportLevel=SUPPORTED  apiDisabled=false
  datastore.indexes.get      customRolesSupportLevel=SUPPORTED  apiDisabled=false
  datastore.indexes.list     customRolesSupportLevel=SUPPORTED  apiDisabled=false
  datastore.indexes.update   customRolesSupportLevel=SUPPORTED  apiDisabled=false

But the protected prod executor holds none of them. Its healthmcp datastore
grants, read from collinbentley1/platform at commit c8d24cd
(tools/ci/protected-bootstrap-bridge.ts), are exactly:

  read:      datastore.databases.get, .getMetadata, .list
  mutation:  datastore.databases.create, .delete, .update,
             datastore.operations.get, .list

`grep -c "datastore.indexes"` over that file returns **0**.

So a protected prod apply would fail on these two resources with a permission
error. Closing this requires adding the `datastore.indexes.*` permissions to the
healthmcp prod mutation matrix in the platform bridge -- a change in the
platform repository, which is deliberately out of scope for this worktree.

## Honest status

Configured, formatted, validated and lint-enforced in code. NOT applied, and
therefore **not yet enforcing anything in the live project**: until the apply
lands, `expiresAt` remains a field nobody acts on, abandoned quota buckets
accumulate, and pending waitlist entries do not expire. The application-side
opportunistic delete remains defence in depth and is unchanged.

---

# Ownership flow: what is implemented, and what is still blocked

## Implemented and tested

- `src/identity-token.ts` verifies an Identity Platform ID token against
  Google's published JWKs: pinned RS256 (an `alg` of `none` or `HS256` is
  refused before any verification), exact `aud` and `iss` for the project,
  bounded clock skew on `exp`/`iat`, and `email_verified === true`. 19 tests
  construct real RSA signatures and feed genuinely hostile tokens through the
  real verify path -- wrong key, tampered payload, wrong project, wrong issuer,
  unverified email, expired, future-dated, unknown `kid`, unavailable key set.
- Single-use promotion. `WaitlistStore.confirm` promotes exactly one pending
  entry; a replay reports `already-confirmed` and leaves the record byte-for-byte
  unchanged, including which subject confirmed it. Firestore does it inside a
  transaction whose read set is the entry, so a concurrent second confirmation
  aborts rather than promoting twice.
- Confirmation clears the expiry to a far-future instant, so a verified member
  is never reaped while the field stays present for the TTL policy to read.
- `POST /api/waitlist/activate` spends the same shared quota, answers uniformly
  for an unverifiable token and an unknown address, and is indistinguishable
  between a first activation and a replay.
- No browser API key exists anywhere in the design, so there is no
  client-callable Identity Platform surface that could bypass the quota.

## Blocked, and on what

The backend dispatch of `accounts:sendOobCode` is NOT implemented, because
Identity Platform is not provisioned for this project and cannot be provisioned
from this repository:

- `identitytoolkit.googleapis.com` and `apikeys.googleapis.com` are available
  and billing is enabled, but both are disabled today.
- Enabling them is an ordinary change to healthmcp's `required_services`, which
  lives in the PLATFORM repository's bootstrap deployment.
- Creating the Identity Platform config additionally needs
  `firebaseauth.configs.create/get/update` in the protected prod executor's
  mutation matrix, which is also in the platform repository. The executor holds
  none of them today.

`IDENTITY_PLATFORM_AUDIENCE` is therefore unset in production, and activation
answers 503 rather than trusting a token whose issuer nobody configured. That is
the intended fail-closed state, but it means **no address can currently reach
`confirmed`**: the verification half is real and tested, and the delivery half
does not exist yet.
