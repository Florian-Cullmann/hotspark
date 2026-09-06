# Contributing

Hotspark is early-stage software for trusted self-hosting. Discuss changes to privilege boundaries, public schemas, migrations and data lifecycle before widening the architecture. Keep API intent separate from generated Compose and restricted agent execution. Never add a generic host-shell endpoint.

Use Node 24, `npm ci`, `npm run generate`, then `make dev`. Before opening a PR run formatting, lint, typecheck, unit tests, database integration and a production build. Regenerate OpenAPI with `npm run openapi`. Real deployment/operations tests require an explicitly disposable installed host; they retain data and must run serially.

Add tests for meaningful security/recovery behavior, commit new Prisma migrations rather than editing released migrations, and document limitations honestly. PRs should explain the problem, resulting behavior, validation and remaining risks. Follow the existing formatting and simple module boundaries. Report vulnerabilities privately as described in SECURITY.md.

Contributions are accepted under the repository's existing MIT license. Do not contribute third-party code or assets without compatible licensing and attribution.
