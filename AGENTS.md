<!-- platform-review-rules -->
## Code Review Rules

- Keep the frontend custom. Put reusable authentication, origin enforcement, and security behavior in the platform runtime; keep domain routes and UI here. Do not edit .platform files directly: consume a reviewed platform upgrade.
- Check actual user ownership and isolation on every protected operation. Account deletion and session revocation require recent authentication. Emulator authentication must never reach Cloud Run. Keep logs free of credentials, email addresses, request bodies, and action codes.
- Prefer the existing managed provider, CodeQL, Socket, and Playwright to additional custom gates. Preserve scale-to-zero and budget limits. Flag consequential defects; leave formatting and lint to CI.
<!-- /platform-review-rules -->
