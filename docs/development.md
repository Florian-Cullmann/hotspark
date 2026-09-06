# Development

Install Node.js 24 and Docker with Compose/Buildx in your development environment. Host Node.js is a development requirement only; installed servers run it in containers. Workspaces use npm and the committed package-lock.json.

```bash
npm ci
make dev
```

The database binds to 127.0.0.1:55432 and uses a persistent development volume. Generated development credentials live under `.dev/` and are ignored by Git. The API runs at 127.0.0.1:3001 and Next.js at 127.0.0.1:3000. API rewrites keep browser requests same-origin. Development does not automatically grant the agent access to your workstation Docker socket. Test full privileged deployment on a disposable Debian 13 server.

```bash
npm run format
npm run format:check
make lint
make typecheck
make test
make build
npm run test:integration
npm run openapi
bash scripts/release.sh
```

Unit tests cover token/password handling, strict schemas, restricted agent operations, isolation-sensitive Compose generation, deterministic plans, health routing, API health and OpenAPI. Shell validation tests exercise root/OS/architecture rejection and both file and piped installation. Database integration creates a disposable PostgreSQL container, applies migrations, checks login/scopes/revocation, verifies domain reservation, concurrent job exclusion and audit persistence, then removes only that test container.

Production builds compile API/agent/SDK TypeScript and build Next.js standalone output. `deployments/Dockerfile` produces three targets. `deployments/compose.yaml` uses host paths by design; do not run it on a workstation without reviewing those paths. CI runs formatting, lint, type checks, tests, database integration and a production build. Release artifacts are deterministic tar archives plus checksums, with a future signing step.

Use `npx prisma migrate dev --schema packages/database/prisma/schema.prisma` against a disposable development database when changing models; commit migrations. Use `npm run db:migrate` in tests and installation. Do not replace migration history with `db push` in production.

Keep changes to privileged behavior narrow. Add rejection tests for new intent fields and verify actual rendered networks/volumes/command arguments. Any new remote-agent transport needs explicit authentication, authorization and replay/reconciliation design. No generic command executor belongs in the public API.

## Disposable host provider integration

After installing v0.4.0 on a disposable Debian host, run from this checkout as root:

```bash
bash tests/providers.integration.sh --disposable-host
```

This pauses the normal API worker, runs real BuildKit/Compose fixtures through the API service layer and durable jobs, and restores the API on exit. Node with PostgreSQL 16, Next standalone with PostgreSQL 18, Prisma migrations, React/Vite with nginx, pnpm/Node 22, Yarn 4, runtime secrets, log redaction, lifecycle and reconciliation are exercised. The harness maps explicitly named fixture Git sources to checked-in build contexts using an injected test runner; production has no local-path source option. It intentionally preserves test projects and data. Never run it on a production host.

Database integration uses a disposable PostgreSQL container and simulated agent responses for deterministic crash/lease/idempotency tests. Unit tests reject unauthorized agent requests and unsafe inputs. Actual ACME issuance, remote agents, hostile build isolation and disaster recovery are not covered by these tests.

To check the installed HTTP API, worker and authenticated agent together:

```bash
docker run --rm -i --network host --user 10001:10001 \
  --mount type=bind,src=/etc/hotspark/secrets/admin_password,dst=/run/secrets/admin_password,readonly \
  hotspark/api:0.4.0 node --input-type=module-typescript < tests/live-smoke.ts
```

Only this operator test probe uses host networking. It creates a PostgreSQL project, exercises idempotency/start/stop/restart/delete and retains the project's data. `TEST_PROVIDERS=pnpm,yarn` can select only the package-manager fixture builds in the provider harness.

`bash tests/tls.integration.sh --disposable-host` verifies TLS routing and redirects with an isolated Traefik container on loopback ports 18080/18443. It removes only its own test container and temporary configuration, and does not test ACME issuance.

Run `bash tests/releases.integration.sh --disposable-host` for immutable Git revision builds, blue/green HTTP switching, failed candidate preservation, image rollback, maintenance, lifecycle and interrupted migration recovery. The test transport maps exactly one GitHub fixture repository to a local Git repository; the production fetcher and real runtime are used. Both host harnesses retain fixture projects/data for inspection and temporarily stop the ordinary API worker.

Optional browser smoke: install Playwright Core 1.58.2 in an external test-tool directory and use an installed Chrome. Run `tests/ui.e2e.ts` with `npx tsx`, setting `PLAYWRIGHT_MODULE` to its `index.mjs`, `CHROME_PATH`, `HOTSPARK_TEST_URL`, and `TEST_PROJECT_ID`. Supply the administrator password on stdin. This test toggles maintenance, so select a disposable fixture project. Browser tooling is not installed on the production server or added to platform runtime dependencies.

## Operational acceptance (0.4)

`bash tests/acceptance.sh --disposable-host` runs a real Next.js + PostgreSQL Git/build/update/failure/rollback sequence, maintenance, a platform service restart, reconciliation, network/socket/resource checks, backup checksums and a real restore drill into a separate temporary database. It then removes only that drill database. Original fixture data and backups are retained. The fixture Git transport is test-injected; production source restrictions are unchanged.

For a host/VM reboot, run `bash tests/operations.acceptance.sh --disposable-host prepare`, reboot the disposable environment, then run `... verify`. Do not reboot a shared production machine for this test. Host harnesses must run serially. A fresh Debian 13 cloud-image VM with no Docker/Node is used for installer acceptance; it is separate from existing hosted application data.

The release pipeline packages checksummed archives and reviewed `release-policy.json` metadata. It does not publish/sign without a configured maintainer identity. Never mark incompatible migrations backward-compatible to bypass the updater's gate.

`TEST_TARGET_VERSION=0.4.1 bash tests/updates.integration.sh --disposable-host` tests checksum rejection and a real versioned update through an operator-owned HTTPS mirror. Add `fail-health` as the second argument with a fresh target version to exercise restoration of the previous platform. It stages trusted local code as root; run only on the disposable host.
