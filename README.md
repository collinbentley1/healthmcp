# Medlock

Medlock is a Model Context Protocol server for privacy-preserving personal health data access, in production since July 2025. It is a pure Bun app that serves the medlock.ai site and an MCP endpoint over Streamable HTTP from one Cloud Run service.

The MCP endpoint is:

```text
https://medlock.ai/api/mcp
```

The same service also answers at `https://mcp.medlock.ai/api/mcp`. The path is `/api/mcp` on both hosts; there is no `/mcp` route, and the root of `mcp.medlock.ai` serves the site, not the protocol (probed 2026-07-08; see [Verify the endpoint yourself](#verify-the-endpoint-yourself)).

**The public deployment serves demo data and says so in the protocol itself.** Responses are deterministic demo vitals (`src/vitals.ts`), and every connecting client is told: the server's `initialize` instructions state that this deployment uses demo Solid Pod data until a user connects their own pod (`src/mcp.ts`), the `solid_fetch_vitals` tool description repeats it, every successful `solid_fetch_vitals` result is tagged `source: "demo-solid-pod"`, and the `medlock://context` resource reports `healthDataMode: "demo-solid-pod"`. For a health-data-shaped demo this disclosure is load-bearing: a model reading this surface is told at every layer that the readings are demo data, not someone's real vitals.

## Install in Claude in 60 seconds

### Claude (web, Desktop, mobile) — custom connector

Steps per Anthropic's [custom connector guide](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp) (verified 2026-07-08):

1. On a Pro/Max plan, go to **Customize > Connectors**. Free plans allow one connector. On Team/Enterprise, an Owner adds connectors under **Organization settings > Connectors** instead.
2. Click **+**, then **Add custom connector**.
3. Enter the remote MCP server URL: `https://medlock.ai/api/mcp`
4. Click **Add**.
5. In a chat, open the **+** menu, select **Connectors**, and toggle Medlock on.

No OAuth setup is needed; the public deployment serves the anonymous demo client.

### Claude Code

Command syntax per the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) (verified 2026-07-08):

```sh
claude mcp add --transport http medlock https://medlock.ai/api/mcp

# confirm it connected
claude mcp list
```

For a private deployment with `MEDLOCK_MCP_TOKEN` set:

```sh
claude mcp add --transport http medlock https://your-host/api/mcp \
  --header "Authorization: Bearer your-token"
```

## Architecture

Each claim below cites the file that implements it.

- **Isolated Streamable HTTP transport.** The MCP endpoint uses the stable `createMcpHandler` per-request factory from `@modelcontextprotocol/server` (`src/mcp.ts`, `package.json`). Each POST gets a fresh MCP server instance, while legacy `initialize` requests retain their SSE `event: message` response.
- **Single request handler.** `src/server.ts` routes `/api/mcp` to the MCP transport, `/api/waitlist` to the waitlist store, and everything else to static assets, with canonical-host 308 redirects for legacy domains (`src/http.ts`, `src/config.ts`).
- **Bearer auth for private deployments.** When `MEDLOCK_MCP_TOKEN` is set, MCP requests without the matching `Authorization: Bearer` header get 401 (`authenticate()` in `src/mcp.ts`; `src/config.ts`). Without a token, requests run as an anonymous demo client with `demo:read` scope. The `medlock://context` resource states the rule: connect real Solid Pods only through a private deployment with the token configured (`src/mcp.ts`).
- **Origin and host allow-listing.** MCP requests from origins outside the allow-list get 403; the same applies to unrecognized `Host` values (`isTrustedOrigin`/`isTrustedHost` in `src/http.ts`, enforced in `src/mcp.ts`; defaults, including `https://claude.ai` and `https://chat.openai.com`, in `src/config.ts`). CORS headers echo only allow-listed origins.
- **Rate limiting.** A bounded in-memory limiter (`src/rate-limit.ts`) atomically caps the waitlist API on each Cloud Run instance at 5 requests per minute per server-minted, HMAC-authenticated client cookie and 60 requests per minute in aggregate (`handleWaitlist()` in `src/server.ts`). Requests without an authenticated cookie also share a per-instance 5-per-minute establishment budget, so discarding cookies cannot rotate through that instance's global budget. These counters reset on instance churn and do not coordinate across the configured maximum of 10 instances; they are abuse friction, not a human-identity or organization-wide quota. A rejected client does not consume any other limiter bucket. The application neither trusts forwarding headers nor collapses unrelated Cloud Run clients onto a proxy socket. The MCP endpoint itself is not rate-limited in application code.
- **Response headers.** Site pages and API responses carry a CSP with `default-src 'self'` and no `unsafe-inline`, `frame-ancestors 'none'`, COOP/CORP `same-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a Permissions-Policy disabling camera, geolocation, microphone, and payment (`SECURITY_HEADERS` in `src/http.ts`). API CORS advertises only POST and OPTIONS and echoes only allow-listed origins.
- **Request body limits.** Bun rejects request bodies larger than 1 MiB, MCP reads at most 64 KiB and rejects JSON-RPC batches, and the waitlist route reads at most 8 KiB before parsing JSON (`src/mcp.ts`, `src/server.ts`).
- **Honest demo data.** Deterministic sample vitals (`src/vitals.ts`) with the disclosure wired through the protocol surface as described above (`src/mcp.ts`).
- **Waitlist storage minimizes linkage.** Waitlist entries store SHA-256 hashes of the opaque client cookie and user agent alongside the email; client IP addresses are neither trusted nor persisted (`src/waitlist.ts`).

## MCP Surface

Tools:

- `solid_fetch_vitals`: returns selected read-only vitals from the demo Solid Pod data source
- `vitals_scan`: prepares a browser scan handoff URL without activating camera hardware from the server

Resource:

- `medlock://context`: deployment and safety context for MCP clients

## Verify the endpoint yourself

A spec-correct Streamable HTTP `initialize` — a JSON-RPC POST accepting both JSON and SSE — is re-runnable against production:

```sh
curl -sS -X POST https://medlock.ai/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}'
```

Expected: HTTP 200 with `content-type: text/event-stream` and an `event: message` frame whose result carries `serverInfo` (`"name": "medlock"`) and instructions disclosing the demo Solid Pod data.

The same probe runs in CI as a contract test: `test/initialize-probe.test.ts` starts the server and asserts the SSE response shape, `serverInfo`, the demo-data disclosure, the 403 for non-allow-listed origins, the 401 when a bearer token is configured but absent, and that a rejected DELETE cannot affect a later POST. Additional tests cover simultaneous duplicate JSON-RPC IDs and oversized waitlist bodies.

## Local Development

Medlock requires Bun `1.4.0` at the exact reviewed revision
`34cbb9a40b4bd1bd767d134a7065e66c2432a676`, matching CI and the production
container. Before installing dependencies or running a repository script, fail
closed on the full embedded revision:

```sh
bun -e 'if (Bun.version !== "1.4.0" || Bun.revision !== "34cbb9a40b4bd1bd767d134a7065e66c2432a676") throw new Error("Bun must be 1.4.0+34cbb9a40")'
bun install
bun run dev
```

Never install or upgrade Bun from a moving `stable`, `latest`, or `canary`
channel for this repository. `bun --revision` is a convenient display check,
but it abbreviates the commit; the assertion above is the canonical local
check. The Docker image pins `bun-v1.4.0` exactly.

Useful commands:

```sh
bun run test
bun run typecheck
bun run verify
```

The MCP endpoint is available at:

```text
http://localhost:3000/api/mcp
```

## Stack

- Bun for the HTTP server, static site build, tests, and tooling
- `@modelcontextprotocol/server` with the `createMcpHandler` per-request factory
- Cloud Run for production and pull request previews
- Terraform for Google Cloud resources
- GitHub Actions OIDC for GitOps deployment

## Configuration

Environment variables:

- `ALLOWED_HOSTS`: comma-separated hosts accepted by the MCP endpoint
- `ALLOWED_ORIGINS`: comma-separated browser origins accepted by API endpoints
- `CANONICAL_HOST`: canonical host used for legacy redirects, default `medlock.ai`
- `DATA_DIR`: local filesystem storage for development waitlist entries when `WAITLIST_BACKEND=file`
- `FIRESTORE_COLLECTION`: Firestore collection for waitlist records, default `waitlist`
- `FIRESTORE_DATABASE_ID`: Firestore database ID, default `(default)`
- `FIRESTORE_PROJECT_ID`: project used by the Firestore REST API; production
  deployment injects the exact reviewed project ID from the immutable platform
  map and does not rely on an ambient `GOOGLE_CLOUD_PROJECT` value
- `LEGACY_HOSTS`: comma-separated hosts redirected to `CANONICAL_HOST`
- `MEDLOCK_MCP_TOKEN`: optional bearer token for private MCP deployments; when set, it must contain at least 32 random bytes
- `PORT`: HTTP port, default `3000`
- `PUBLIC_DIR`: static asset directory override
- `WAITLIST_BACKEND`: `file`, `memory`, or `firestore`; production uses `firestore`, pull request previews use `memory`
- `WAITLIST_IDENTITY_KEYSET`: one unpadded base64url-encoded 32-byte signing key; deployed services require it. During local or private-deployment rotation, configure `new,old` so old cookies are accepted and immediately re-signed with `new`. After the 30-day cookie lifetime has elapsed, remove `old`. Production never sources this value from GitHub. The trusted platform deploy reuses the one exact numeric Secret Manager version already bound to Cloud Run or, only when both the binding and enabled-version inventory are empty, generates a key and streams it directly into a new version before binding that numeric version. The platform generates a revision-local preview value during each trusted deploy.

## Cloud Run Setup

The repository follows the shared platform contract:

- `infra/terraform/bootstrap` and `infra/terraform/prod`: validation/documentation mirrors only; they are not an apply surface
- `.github/workflows/application.yml`: Bun verification
- `.github/workflows/infrastructure.yml`: Terraform validation and read-only convergence checks
- `.github/workflows/deploy-prod.yml`: main branch container deployment
- `.github/workflows/deploy-preview.yml`: tagged pull request traffic on the single no-data `medlock-preview` service
- `.github/workflows/reconcile-previews.yml`: exact-revision cleanup and reconciliation for shared preview traffic

Every caller and Terraform mirror pins the same reviewed full platform SHA. Authenticated infrastructure work checks out only that platform commit and selects the immutable platform-owned deployment configuration by numeric GitHub repository ID; it never executes consumer HCL. Bootstrap, production, and public-exposure changes must run through the owner-controlled, review-gated pipeline against `platform/terraform/deployments`, not a manual apply from this repository. Actions may be enabled only after that pipeline, its state migration, exact-SHA WIF, and SHA-only enforcement are verified. See the [pinned security rollout](https://github.com/collinbentley1/platform/blob/ddaa918319be123c780876d510efb4715c1f879d/docs/security-rollout.md).

Do not define `GCP_*` repository variables or repository-level deploy secrets.
The sole credential-bearing build environment is
`dhi-base-prefetch-20260822-098dca9280b3`, shared by preview and production.
It contains exactly the public-read-only
`DHI_PUBLIC_READ_TOKEN_20260822_098DCA9280B3` secret and the non-confidential
`DHI_USERNAME` variable. No Socket token, mutable Grype database manifest, or
`WAITLIST_IDENTITY_KEYSET` exists at any GitHub scope. Socket uses public
policy, Grype data is byte-pinned in the reviewed platform commit, and the
trusted deploy manages the production waitlist key directly in Secret Manager.
After inventory proof and old provider-token revocation, the retired
`preview-build`, `production-build`, and `dependency-scan` environments
must be empty and deleted. Publish, deploy, preview-operations, and supply-chain
environments remain secretless for Medlock. All other runtime configuration,
including the production Firestore backend and memory-only preview mode, is
selected in reviewed platform code rather than repository variables.

Build, Artifact Registry publication, Cloud Run deployment, preview operations, and supply-chain attestation use separate protected environments and least-scope identities. External-fork and Dependabot pull requests receive neither those environment secrets nor a cloud preview.
