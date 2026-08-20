# Medlock

Medlock is a pure Bun app that serves a frontend site and a Model Context Protocol server over Streamable HTTP.

The public deployment returns deterministic demo vitals. Private deployments can connect the same MCP tool surface to a user's Solid Pod and should configure bearer auth before exposing real data.

## Stack

- Bun for the HTTP server, static site build, tests, and tooling
- `@modelcontextprotocol/server` with `WebStandardStreamableHTTPServerTransport`
- Cloud Run for production and pull request previews
- Terraform for Google Cloud resources
- GitHub Actions OIDC for GitOps deployment

## Local Development

```sh
bun install
bun run dev
```

Medlock targets stable Bun 1.4. Run `bun upgrade --stable` to bring a local install up to date; the Docker image pins `bun-v1.4.0` exactly.

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

## MCP Surface

Tools:

- `solid_fetch_vitals`: returns selected read-only vitals from the demo Solid Pod data source
- `vitals_scan`: prepares a browser scan handoff URL without activating camera hardware from the server

Resource:

- `medlock://context`: deployment and safety context for MCP clients

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
