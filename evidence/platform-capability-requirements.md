# Platform capability requirements

Everything below is what HealthMCP cannot do for itself. Each item states the
exact API call, the exact permission, the principal that needs it, and how the
grant is verified afterwards. All observations were taken read-only against
project `medlock-1025243085` on 2026-09-01.

The HealthMCP side of each item is already implemented and merged into this
branch; these are the grants that turn declared configuration into enforced
configuration.

---

## 1. Firestore TTL

### Current state, observed

```
GET /v1/projects/medlock-1025243085/databases/(default)/collectionGroups/-/fields?filter=ttlConfig:*
-> {}
```

No field in the database has a TTL policy. Reading the two fields directly
confirms it: both `waitlist/expiresAt` and `waitlist_quota/expiresAt` exist with
a default `indexConfig` and no `ttlConfig` key at all. `expiresAt` is therefore
inert -- the application writes it, and nothing reaps on it.

### Why the pipeline cannot apply it

Project IAM bindings for the pipeline principals:

| principal | roles |
|---|---|
| `gha-prod-deploy` | *(no project-level bindings)* |
| `gha-prod-publish` | *(no project-level bindings)* |
| `gha-deploy-parity` | *(no project-level bindings)* |
| `gha-terraform` | `projects/medlock-1025243085/roles/terraformConvergenceReader` |
| `cloud-run-runtime` | `roles/datastore.user` |

`terraformConvergenceReader` carries `datastore.databases.get`,
`datastore.databases.getMetadata`, `datastore.databases.list` and no
`datastore.indexes.*`. `google_firestore_field` calls
`projects.databases.collectionGroups.fields.patch`, so the apply fails.

### The grant

`google_firestore_field` patches an existing field; fields are never created or
deleted, and Terraform's destroy path is also a patch back to defaults. So
`create` and `delete` are not required.

```
role: projects/medlock-1025243085/roles/firestoreFieldTtlAdmin   (new custom role)
permissions:
  datastore.indexes.get
  datastore.indexes.list
  datastore.indexes.update
member: serviceAccount:gha-terraform@medlock-1025243085.iam.gserviceaccount.com
scope: project medlock-1025243085
```

Two notes on picking this over a predefined role:

- **`roles/datastore.indexAdmin` is the wrong grant.** Its permission list is
  `datastore.schemas.*`, not `datastore.indexes.*`; it does not contain
  `datastore.indexes.update`. Neither does `roles/datastore.owner` or
  `roles/editor`.
- All five `datastore.indexes.*` permissions are custom-role supported and the
  API is enabled, verified with `gcloud iam list-testable-permissions`, so the
  three-permission custom role above is achievable rather than aspirational.

Firestore IAM has no sub-project scope, so a project-level binding is the
tightest available; the role's three permissions are what keep it least
privilege.

### Verification after the grant

```bash
bun run verify:ttl
```

Reads the live field configuration and exits non-zero unless every declared
collection has an **ACTIVE** policy. `CREATING` and `NEEDS_REPAIR` deliberately
fail: neither is reaping. Run against the project today it prints

```
FAIL waitlist.expiresAt: no TTL policy names this field, so expiresAt is inert
FAIL waitlist_quota.expiresAt: no TTL policy names this field, so expiresAt is inert
```

and exits 1. That is the check flipping to exit 0 that closes this item.

The gate needs only `datastore.indexes.get`, so it can run from a read-only
identity in CI.

---

## 2. Identity Platform

### Current state, observed

```
GET /v1/projects/medlock-1025243085/services/identitytoolkit.googleapis.com
-> state: DISABLED
```

The API is off, so the config endpoint returns `PERMISSION_DENIED` with "Identity
Toolkit API has not been used in project ... before or it is disabled". No
Identity Platform configuration exists.

### The grants

**a. Enable the service and write the config.** Declared in
`infra/terraform/prod/main.tf` as `google_project_service.identity_toolkit` and
`google_identity_platform_config.default`. The applying principal needs:

```
serviceusage.services.enable
firebaseauth.configs.create
firebaseauth.configs.get
firebaseauth.configs.update
member: serviceAccount:gha-terraform@medlock-1025243085.iam.gserviceaccount.com
```

**b. Let the runtime send the challenge.** `cloud-run-runtime` holds only
`roles/datastore.user` today. Dispatch calls
`POST /v1/projects/{project}/accounts:sendOobCode` with the runtime identity:

```
role: projects/medlock-1025243085/roles/waitlistChallengeSender   (new custom role)
permissions:
  firebaseauth.users.sendEmail
member: serviceAccount:cloud-run-runtime@medlock-1025243085.iam.gserviceaccount.com
```

`firebaseauth.users.sendEmail` exists as a grantable permission on this project
(confirmed via `list-testable-permissions`). Do **not** use
`roles/firebaseauth.admin`: it also carries `users.create`, `users.delete`,
`users.update`, and `configs.getSecret`, none of which dispatch needs.

That the send endpoint accepts exactly this permission and no more cannot be
confirmed while the API is disabled. Confirm immediately after enablement:

```bash
gcloud projects test-iam-permissions medlock-1025243085 \
  --permissions=firebaseauth.users.sendEmail
```

and by observing a real dispatch succeed. If the endpoint demands more, widen by
single permissions rather than by taking the predefined role.

### No API key, deliberately

There is no browser API key in this design and none should be created. A public
key makes `sendOobCode` callable by anyone who reads the page, for any address
-- an open mail relay pointed at strangers and charged to this domain's sending
reputation. Referrer restrictions do not fix it; they are a browser convention,
not an authorization boundary. Dispatch runs server-side under the runtime
identity, behind the shared quota and a membership check.

### Still open: the exchange leg

Dispatch and activation are implemented and tested. The middle step -- turning
the `oobCode` from the mailed link into an ID token -- is **not** implemented,
and this is the one part of the campaign that is not merely awaiting a grant.

The standard client-side exchange (`accounts:signInWithEmailLink` with a public
API key) is exactly the surface rejected above. Two viable alternatives:

1. **Project-scoped admin exchange** under the runtime bearer token, mirroring
   dispatch. Preferred if it exists; its wire contract cannot be confirmed while
   the API is disabled.
2. **Server-held API key** in Secret Manager, used only from the backend and
   never served to a browser. Works for certain, but introduces a credential to
   store and rotate.

Resolve by enabling the API and probing (1) before committing to (2). Until then
activation correctly returns 503 and no address can reach `confirmed`.

Staging any resulting secret is the owner's action, not something this workflow
performs.

---

## What does not require platform

Already implemented and verified in this branch: structured decoding of Firestore
error envelopes, the transform-result admission bound, the `updateTime`
compare-and-swap for confirmation, the retry deadline, record validation, the
challenge endpoint with its uniform response, `auth_time` freshness, and the
TTL verification gate.
