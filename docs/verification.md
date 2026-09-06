# Verification record

Verified on 2026-09-07 for the 0.4 operations phase. This is implementation validation, not a production security audit. Test-only versions 0.4.1–0.4.3 were built on the disposable server to exercise updates; they are not public releases.

## Development checks

Formatting, ESLint/shell syntax, both TypeScript configurations, 38 unit/schema/API/agent tests, installer validation, PostgreSQL integration tests and production TypeScript/Next.js builds pass. A clean `npm ci`, compiled CLI launcher and release archive generation are checked. OpenAPI is generated from the public routes.

The database integration suite applies all four committed migrations to a disposable PostgreSQL container. It covers asynchronous provisioning, idempotency, encryption, scoped permissions, domain conflicts, leases/replay/retries, reconciliation, cancellation, project updates, data-preserving deletion and HTTP SDK calls. Operational coverage adds task idempotency/lost acknowledgments, authenticated diagnostics/metrics, read-only monitoring tokens, logout revocation, retention and the persistent update gate. Unit tests cover interrupted-backup classification, failed dump validation, safe release retention, GC replay, terminal sanitization and webhook destination restrictions.

## Installation and updates

The bootstrap was run on fully updated Debian 13 amd64 virtual machines starting without Docker or Node.js. It installs official Docker packages and all platform services without host Node.js. Repeated installation preserves generated secrets. Platform-only uninstall and reinstall preserve database files/configuration. Installation uses the versioned CLI symlink and shared host update lock.

On the authorized Debian playground, real updates through the public API and a temporary trusted HTTPS mirror verified:

- Incorrect archive checksum: failed task; old platform remains healthy.
- Compatible target: validated pre-migration database backup, migrations, platform health checks, version pointer activation and durable completion.
- Intentionally unhealthy target API: failed update restores the previous platform version.
- Hosted application active release IDs and desired states remain unchanged throughout.

The mirror used an administrator-installed test CA; TLS verification was not disabled. Mirror configuration was restored after each test. Old/staged release directories and backups remain available for inspection.

## Docker, HTTP and recovery

`tests/acceptance.sh --disposable-host` uses a real Next.js standalone + PostgreSQL fixture, exact Git commits, the platform-owned bounded BuildKit builder, Compose, persistent jobs and Traefik. It verifies initial HTTP/SQL, healthy release switching with the old release online during build, failed-health preservation of the previous release, image-only rollback, project-specific maintenance, concurrent project builds/same-project exclusion and uncertain-migration recovery.

Operational probes verify platform service restart, maintenance persistence, unchanged active release, intentionally stopped state, resumed HTTP/SQL, database network isolation, no PostgreSQL public ports, no application Docker socket mounts and container resource limits. Project backups are hashed and restored into a separate temporary database; a SQL marker is checked before deleting only that drill database. Doctor and GC dry-run protection are checked through REST.

The installed UI rewrite → API → durable worker → authenticated agent lifecycle smoke passes. Headless Chrome verifies login, deployment history/detail, logs, maintenance, project resource usage and System diagnostics. The compiled CLI passes login, doctor, project listing, logs and server-side logout against the installed API.

A real host reboot passes the same recovery checks: Docker and all platform services recover, the shared maintenance page and active release survive, and intentionally stopped applications remain stopped. The readiness probe retries transient connection resets within a bounded window during startup/routing changes.

Provider regressions cover Node/npm with PostgreSQL 16, Next standalone with PostgreSQL 18 and Prisma, React/Vite with nginx, pnpm on Node 22 and Yarn 4 on Node 24. The test harness owns fixture Git transport; production API clients cannot enable local Git transport. Runtime and migration images remain separate. TLS tests use an isolated default certificate and verify HTTP-to-HTTPS redirects, without requesting ACME issuance.

The post-reboot operational acceptance also applies owned image/cache GC, confirms every volume and the active HTTP release remain, and creates a platform backup whose dump/configuration/runtime artifacts pass size and SHA-256 validation. The project dump is restored and queried, rather than relying only on a table-of-contents check. Final fixture backups are `4fe8ce59-a6f9-4eb9-9469-1493daaaf603` (project) and `59fbda8d-8554-47c8-bd47-5e7d73a4da94` (platform) on the disposable host. Backup IDs are diagnostic references, not portable download links.

Superseded provider fixture projects were removed through the public API when Docker bridge address pools approached capacity; their volumes were retained. Current acceptance/provider fixtures and the powered-off fresh-install VMs remain available for inspection.

## Limits

No arm64 hardware run, real ACME issuance/renewal, hostile-tenant penetration test, sustained-load test, live third-party webhook delivery or complete host disaster-restore drill is claimed. Interrupted-journal tests do not cover every power-loss/filesystem failure. Local atomic state replacement is not an fsync-backed distributed transaction. Traefik reloads asynchronously and blue/green deployments require overlapping capacity.

Backups are local and unencrypted; off-host encryption/copy and full recovery drills remain operator responsibilities. Immutable images are not included in logical backups. GC is explicit and conservative; retained disk metadata and backups require capacity planning. There are no disk quotas. Docker is not a VM boundary or a safe hostile-tenant sandbox. Remote workers, tenant RBAC, database major upgrades, key rotation and public signing/distribution remain open. Application rollback never rolls back a database.
