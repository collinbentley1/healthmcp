# Security Policy

## Reporting

Do not open public issues for security reports. Use GitHub private vulnerability reporting on this repository and include impact, reproduction steps, and any suggested mitigation.

## Current Security Model

- The public MCP deployment serves demo data only.
- Private deployments should set `MEDLOCK_MCP_TOKEN` before connecting real Solid Pod data.
- The MCP endpoint validates allowed hosts and origins.
- The public MCP route accepts only POST and OPTIONS, and creates a fresh MCP server instance for each POST.
- Bun caps request bodies at 1 MiB; MCP has a 64 KiB single-message limit with batches rejected, and the waitlist JSON parser has a smaller 8 KiB limit.
- Tool results are read-only and avoid server-triggered camera access.
- The waitlist stores production contact records in Firestore through the Bun API when `WAITLIST_BACKEND=firestore`.
- Pull request previews set `WAITLIST_BACKEND=memory`, so preview signups are ephemeral and do not write to production Firestore.
- Error responses do not include stack traces.

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
