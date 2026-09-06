# Verification record

Verified on 2026-09-06 for the 0.3 immutable-deployment phase. This is implementation validation, not a production security audit.

## Development checks

`npm run format:check`, ESLint/shell syntax checks, both TypeScript configurations, 30 unit/schema/API/agent tests, installer validation, PostgreSQL integration tests, and production TypeScript/Next.js builds pass. OpenAPI is regenerated from route schemas. The database integration suite applies committed migrations to a disposable PostgreSQL container and exercises asynchronous provisioning, idempotency, encryption, scoped permissions, domain conflicts, leases/replay/retries, reconciliation, cancellation, project updates, data-preserving deletion and real HTTP SDK calls.

Release unit tests additionally cover failed candidate preservation, image rollback without rebuilding, maintenance, interrupted/committed activation recovery, uncertain migration handling, per-project OS locking, empty-route omission, database-only lifecycle, secret-file reconstruction, bounded command output, timeouts, cancellation, and separation of diagnostic output from structured command results.

## Real Docker and HTTP checks

The authorized Debian 13 amd64 playground was upgraded after a control-plane PostgreSQL backup. Existing hosted application data was preserved. The platform runs API, agent, web UI, PostgreSQL, Traefik and the shared maintenance service. Host Node.js is not required.

`tests/releases.integration.sh --disposable-host` passes using the real Git fetcher with an operator-only local transport fixture, BuildKit, Compose, PostgreSQL, the API service layer, durable jobs and Traefik. Verified scenarios:

- Two isolated projects deploy concurrently; a second same-project request receives 409.
- Initial application HTTP response and PostgreSQL connectivity/persistent marker.
- The old HTTP release remains available during a new build; a healthy candidate takes traffic.
- An HTTP-unhealthy revision fails, is cleaned up, and leaves the previous release active.
- Manual rollback reuses an immutable image without rebuilding or replaying migrations.
- Shared HTTP 503 maintenance affects only the selected project; another project and API health remain available.
- Start, stop and restart preserve the active deployment ID and do not build.
- An interrupted migration journal is classified as uncertain and never replayed.
- Git tag resolution records the exact commit; deployment detail retains its timeline.

Provider regression scenarios passed across reruns: Node/npm with PostgreSQL 16, Next standalone with PostgreSQL 18 and Prisma, React/Vite with nginx, pnpm on Node 22, and Yarn 4 on Node 24. Checks include production startup, literal environment values, secret redaction, private database networking, lifecycle and out-of-band stop/reconciliation. Runtime and migration images are separate. Tests found and fixed empty Traefik files, diagnostic output contaminating structured Docker results, Compose dollar escaping, and the Yarn launcher conflict.

The installed HTTP UI rewrite → API → background worker → authenticated Unix-socket agent passes `tests/live-smoke.ts`, including database-only provisioning, idempotency, start/stop/restart/delete and persistent-data preservation. `tests/ui.e2e.ts` passes in headless Chrome: administrator login, active release, deployment list/detail, timeline, logs, rollback availability, and maintenance toggling. `tests/tls.integration.sh` verifies TLS routing and HTTP-to-HTTPS redirects using an isolated default test certificate; it does not request ACME issuance.

A real server reboot also passed: all six platform services became healthy, the active image and manual maintenance state survived, restored secret files retained mode 0400 and their service ownership, and disabling maintenance restored HTTP with the original database marker. The Next standalone runtime was inspected to confirm that the separate Prisma migration CLI was absent.

Old disposable fixture containers/networks were removed when Docker's default address pools were exhausted. Their database volumes and deployment records were retained. Current fixtures remain for inspection.

## Limits

No arm64 hardware run, real ACME issuance/renewal, hostile-tenant penetration test, sustained-load test, or complete backup-restore disaster drill is claimed. Crash-window tests use persisted interrupted journals; they do not cover every power-loss/filesystem failure. Local atomic state replacement is not an fsync-backed distributed transaction. Traefik reloads asynchronously, and current/previous releases consume overlapping capacity. Images remain local and are not automatically garbage-collected. Docker address-pool capacity requires operator planning.

Build scripts and package fetching are not bit-reproducible. Remote workers, tenant RBAC, automated database upgrades, key rotation and public release signing/distribution remain open. Database rollback is intentionally not part of application rollback. Earlier 0.1/0.2 verification remains historical context; use the current lifecycle and recovery documentation for 0.3 behavior.
