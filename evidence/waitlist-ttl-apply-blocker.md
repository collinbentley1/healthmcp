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
