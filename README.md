# Medlock

Medlock is a Model Context Protocol server for privacy-preserving personal health data access, in production since July 2025. It is a pure Bun app that serves the medlock.ai site and an MCP endpoint over Streamable HTTP from one Cloud Run service.

The MCP endpoint is:

```text
https://medlock.ai/api/mcp
```

The same service also answers at `https://mcp.medlock.ai/api/mcp`. The path is `/api/mcp` on both hosts; there is no `/mcp` route, and the root of `mcp.medlock.ai` serves the site, not the protocol (probed 2026-07-08; see [Verify the endpoint yourself](#verify-the-endpoint-yourself)).

**The public deployment serves demo data and says so in the protocol itself.** Responses are deterministic demo vitals (`src/vitals.ts`), and every connecting client is told: the server's `initialize` instructions state that this deployment uses demo Solid Pod data until a user connects their own pod (`src/mcp.ts`), the `solid_fetch_vitals` tool description repeats it, every tool result is tagged `source: "demo-solid-pod"`, and the `medlock://context` resource reports `healthDataMode: "demo-solid-pod"`. For a health-data-shaped demo this disclosure is load-bearing: a model reading this surface is told at every layer that the readings are demo data, not someone's real vitals.

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

- **Streamable HTTP transport.** The MCP endpoint uses `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server` (`src/mcp.ts`, `package.json`). `initialize` requests are answered as SSE `event: message` frames.
- **Single request handler.** `src/server.ts` routes `/api/mcp` to the MCP transport, `/api/waitlist` to the waitlist store, and everything else to static assets, with canonical-host 308 redirects for legacy domains (`src/http.ts`, `src/config.ts`).
- **Bearer auth for private deployments.** When `MEDLOCK_MCP_TOKEN` is set, MCP requests without the matching `Authorization: Bearer` header get 401 (`authenticate()` in `src/mcp.ts`; `src/config.ts`). Without a token, requests run as an anonymous demo client with `demo:read` scope. The `medlock://context` resource states the rule: connect real Solid Pods only through a private deployment with the token configured (`src/mcp.ts`).
- **Origin and host allow-listing.** MCP requests from origins outside the allow-list get 403; the same applies to unrecognized `Host` values (`isTrustedOrigin`/`isTrustedHost` in `src/http.ts`, enforced in `src/mcp.ts`; defaults, including `https://claude.ai` and `https://chat.openai.com`, in `src/config.ts`). CORS headers echo only allow-listed origins.
- **Rate limiting.** An in-memory limiter (`src/rate-limit.ts`) caps the waitlist API at 5 requests per minute per client IP (`handleWaitlist()` in `src/server.ts`). The MCP endpoint itself is not rate-limited in application code.
- **Response headers.** Site pages, API JSON, and error responses carry a CSP with `default-src 'self'` and no `unsafe-inline`, `frame-ancestors 'none'`, COOP/CORP `same-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a Permissions-Policy disabling camera, geolocation, microphone, and payment (`SECURITY_HEADERS` in `src/http.ts`, applied via `json()`, `text()`, and the static file server in `src/server.ts`). Successful MCP protocol responses pass through the transport with allow-list CORS headers (`withCors` in `src/http.ts`) rather than the page-security set.
- **Honest demo data.** Deterministic sample vitals (`src/vitals.ts`) with the disclosure wired through the protocol surface as described above (`src/mcp.ts`).
- **Waitlist storage hashes what it can.** Waitlist entries store SHA-256 hashes of IP and user agent alongside the email (`src/waitlist.ts`).

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

The same probe runs in CI as a contract test: `test/initialize-probe.test.ts` starts the server and asserts the SSE response shape, `serverInfo`, the demo-data disclosure, the 403 for non-allow-listed origins, and the 401 when a bearer token is configured but absent.

## Local Development

```sh
bun install
bun run dev
```

Useful commands:

```sh
bun run test
bun run typecheck
bun run verify
bun run mcp:inspect
```

The MCP endpoint is available at:

```text
http://localhost:3000/api/mcp
```

## Stack

- Bun for the HTTP server, static site build, tests, and tooling
- `@modelcontextprotocol/server` with `WebStandardStreamableHTTPServerTransport`
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
- `FIRESTORE_PROJECT_ID`: project used by the Firestore REST API; Cloud Run also sets `GOOGLE_CLOUD_PROJECT`
- `LEGACY_HOSTS`: comma-separated hosts redirected to `CANONICAL_HOST`
- `MEDLOCK_MCP_TOKEN`: optional bearer token for private MCP deployments
- `PORT`: HTTP port, default `3000`
- `PUBLIC_DIR`: static asset directory override
- `WAITLIST_BACKEND`: `file`, `memory`, or `firestore`; production uses `firestore`, pull request previews use `memory`

## Cloud Run Setup

The repo follows the same shape as `collinbentley1/cdbentley`:

- `infra/terraform/bootstrap`: project services, Terraform state bucket, GitHub OIDC, and service accounts
- `infra/terraform/prod`: Artifact Registry, Firestore, Cloud Run, and custom domain mappings
- `.github/workflows/application.yml`: Bun verification
- `.github/workflows/infrastructure.yml`: Terraform validation and production apply
- `.github/workflows/deploy-prod.yml`: main branch container deployment
- `.github/workflows/deploy-preview.yml`: pull request preview deployments

Production expects the GitHub repository variables emitted by bootstrap outputs:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_TERRAFORM_SERVICE_ACCOUNT`
- `GCP_PROD_DEPLOY_SERVICE_ACCOUNT`
- `GCP_PREVIEW_DEPLOY_SERVICE_ACCOUNT`
- `GCP_RUNTIME_SERVICE_ACCOUNT`

The Dockerfile uses Docker Hardened Images, so repository secrets `DHI_USERNAME` and `DHI_ACCESS_TOKEN` are also required for GitHub Actions deploy jobs.
