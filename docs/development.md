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

## Disposable host smoke test

After installing on a disposable server, run the following there with this checkout available:

```bash
docker run --rm -i --network host --user 10001:10001 \
  -e HOTSPARK_TEST_GIT=true \
  --mount type=bind,src=/etc/hotspark/secrets/admin_password,dst=/run/secrets/admin_password,readonly \
  hotspark/api:0.1.0 node --input-type=module-typescript < tests/host-smoke.ts
```

This operator-run test probe uses host networking to check the actual loopback ports; hosted applications never use host networking. It creates two image-based projects with PostgreSQL, verifies routing and independent stop/start, checks the UI/API rewrite, and optionally builds a public Git repository at a fixed commit. It deliberately preserves the test projects and data. The Git fixture's Dockerfile and dependencies belong to an external project; this is a build-path test, not a reproducibility or security endorsement.
