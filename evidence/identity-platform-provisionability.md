# Identity Platform provisionability for healthmcp — authoritative evidence

Date: 2026-09-01. Project: medlock-1025243085.

I initially concluded the passwordless path was unavailable because
`identitytoolkit.googleapis.com` was not enabled and no API key existed. That was
not evidence of anything: "disabled" is not "unprovisionable". Re-checked against
the four gates that actually decide it.

## Gate 1 — billing: ENABLED
GET cloudbilling.googleapis.com/v1/projects/medlock-1025243085/billingInfo
  billingEnabled: true
  billingAccountName: billingAccounts/017B05-2C45A0-12BD68

## Gate 2 — services available to enable on this project: YES
`gcloud services list --available` returns all three:
  apikeys.googleapis.com            API Keys API
  firebase.googleapis.com           Firebase Management API
  identitytoolkit.googleapis.com    Identity Toolkit API

## Gate 3 — provider support at the pinned version (google = 7.45.0): YES
`terraform providers schema -json` against hashicorp/google 7.45.0:
  google_identity_platform_config   SUPPORTED
    blocks: blocking_functions, client, mfa, monitoring, multi_tenant, quota,
            sign_in, sms_region_config
    sign_in blocks: anonymous, email, phone_number
    top attributes: authorized_domains, autodelete_anonymous_users, project
  google_apikeys_key                SUPPORTED
    restrictions blocks: android_key_restrictions, api_targets,
                         browser_key_restrictions, ios_key_restrictions,
                         server_key_restrictions
  google_project_service            SUPPORTED   (already used by the platform)
  google_firestore_field            SUPPORTED   (TTL policies, if wanted)
So the exact shape required is expressible: email sign-in with password_required
false, phone/anonymous disabled, authorized_domains pinned, and a key restricted
to api_targets = identitytoolkit.googleapis.com plus browser referrer allowlist.

## Gate 4 — permissions: reachable in-band, no console step
Service enablement is ALREADY Terraform-managed:
  terraform/modules/bootstrap/main.tf:128  resource "google_project_service" "required"
driven per consumer by `required_services` in
  terraform/deployments/bootstrap/main.tf
and the bootstrap-root protected executor already holds
  serviceusage.services.enable   (protected-bootstrap-bridge.ts:1906)
so adding identitytoolkit.googleapis.com / apikeys.googleapis.com to healthmcp's
required_services is an ordinary reviewed change on the protected path.

The remaining permissions are not held today and must be added to the prod-root
mutation matrix for healthmcp. Authoritative names, from
`gcloud iam roles describe`:
  roles/identityplatform.admin  -> firebaseauth.configs.create/get/update
  roles/serviceusage.apiKeysAdmin -> apikeys.keys.create/delete/get/getKeyString/list/update

All of them are grantable through the ephemeral custom role the executor uses.
From `gcloud iam list-testable-permissions` (13,516 permissions returned):
  apikeys.keys.create        customRolesSupportLevel=SUPPORTED  stage=BETA
  apikeys.keys.delete        customRolesSupportLevel=SUPPORTED  stage=BETA
  apikeys.keys.get           customRolesSupportLevel=SUPPORTED  stage=BETA
  apikeys.keys.getKeyString  customRolesSupportLevel=SUPPORTED  stage=GA
  apikeys.keys.list          customRolesSupportLevel=SUPPORTED  stage=BETA
  apikeys.keys.update        customRolesSupportLevel=SUPPORTED  stage=BETA
  firebaseauth.configs.create customRolesSupportLevel=SUPPORTED stage=GA  apiDisabled=true
  firebaseauth.configs.get    customRolesSupportLevel=SUPPORTED stage=GA  apiDisabled=true
  firebaseauth.configs.update customRolesSupportLevel=SUPPORTED stage=GA  apiDisabled=true
`apiDisabled=true` on the firebaseauth permissions reflects only that
identitytoolkit is not enabled yet -- which is what gate 4's first half fixes.

## Verdict
No authoritative permission, billing, or unsupported-resource failure exists.
The pending-only fallback is NOT justified, and is not being taken. The real
passwordless email-link flow is provisionable end to end on the protected path.

## Consequence for sequencing
F-02 (enumeration) and F-03 (bypassable limits) are pure application concerns and
are being closed first, with no infrastructure dependency. The Identity Platform
activation path follows as its own reviewed change, because it needs a bootstrap
protected apply (service enablement) and a prod protected apply (config + key),
each of which requires the owner to stage the run token.

---

## Addendum — anti-abuse boundary and TTL (2026-09-01, after review)

### A browser API key is not a boundary, so none is issued
A `google_apikeys_key` restricted by `browser_key_restrictions.allowed_referrers`
is restricted by a request header the caller chooses. It cannot be the
authoritative anti-abuse control, and treating it as one would put a
client-callable path *around* the Firestore quota.

Design taken instead: **no API key ever reaches a browser.** Every Identity
Platform call is server-side, behind the Firestore quota:
  - `accounts:sendOobCode` (requestType EMAIL_SIGNIN) is dispatched by the
    backend with the runtime service account's OAuth token plus
    `targetProjectId`, which requires `firebaseauth.users.sendEmail`.
  - the oobCode returned to the browser by Google's action handler is exchanged
    server-side; if that exchange needs a key it is a server key held in Secret
    Manager and never served to a client.
Possession of the oobCode proves mailbox control; the ID token is then verified
by the backend for signature, `iss`, `aud` == project, `exp`, and
`email_verified == true` before any entry is activated.

### reCAPTCHA ENFORCE: UNSUPPORTED at the pinned provider version — exact evidence
`terraform providers schema -json` for hashicorp/google **7.45.0**:

  google_identity_platform_config block_types:
    blocking_functions, client, mfa, monitoring, multi_tenant, quota,
    sign_in, sms_region_config, timeouts
  google_identity_platform_config attributes:
    authorized_domains, autodelete_anonymous_users, id, name, project

There is no `recaptcha_config` block, so Identity Platform's
`recaptchaConfig.emailPasswordEnforcementState` cannot be set through this
provider version. The only reCAPTCHA resources it exposes are
`google_recaptcha_enterprise_key`, `google_firebase_app_check_recaptcha_enterprise_config`
and `google_firebase_app_check_recaptcha_v3_config`, none of which configure
Identity Platform sign-in enforcement.

This is recorded as an unsupported-resource gap rather than worked around. It
does not leave an open path: reCAPTCHA ENFORCE would be defence-in-depth for a
*client-callable* Identity Platform surface, and this design issues none. Closing
it properly needs either a provider version that exposes the block or an
out-of-band API call, and an out-of-band mutating cloud write is exactly what the
protected pipeline exists to forbid.

### Firestore TTL: SUPPORTED, and required
`expiresAt` on a document does nothing on its own. Firestore only deletes on a
timestamp field when a TTL policy names that field, and the opportunistic
"delete the bucket two windows back" in the quota only ever fires for a key that
receives another request -- an abandoned `waitlist:email:<hash>` or
`waitlist:client:<id>` bucket never does, and so would leak permanently.

`google_firestore_field` at 7.45.0 supports this:
  attributes : collection, database, deletion_policy, field, project, skip_wait
  block_types: index_config, timeouts, ttl_config
  ttl_config.expiration_offset — offset in seconds relative to the field's
                                 timestamp; omit for no offset
  ttl_config.state             — computed

So real TTL policies are provisioned for BOTH collections (pending waitlist
entries on `expiresAt`, quota buckets on `expiresAt`), and the opportunistic
delete is retained only as defence in depth.
