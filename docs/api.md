# REST API v1

The API binds to loopback port 3001; the Next.js UI proxies `/api/v1` on port 3000. Use SSH forwarding or a separately secured administration endpoint. [OpenAPI](openapi.json) is generated with `npm run openapi` and served at `/api/v1/openapi.json`. Shared TypeScript schemas live in `@hotspark/application-spec`; `@hotspark/sdk` provides a client.

## Authentication

POST `/api/v1/auth/login` with `{"email":"admin@localhost","password":"..."}` returns an eight-hour bearer token. Create scoped automation tokens with POST `/api/v1/tokens` as admin; GET lists token metadata, DELETE `/api/v1/tokens/:id` revokes. Token values are returned once and stored only as hashes. See OpenAPI for token expiration fields. Supported scopes are `projects:read`, `projects:create`, `projects:update`, `projects:delete`, `logs:read`, `domains:manage`, and `admin`. Legacy read/deploy scopes remain compatible. These are global administrator permissions, not project-level multi-tenant RBAC.

## Create Next.js + PostgreSQL

Replace the repository, full commit hash and domain with a reviewed application you control. This example assumes `npm ci`, a production `build` script, Prisma committed migrations and Next's `output: "standalone"` configuration. Prisma and generated client must be installed in the image. Production database access is not available during image build.

```bash
curl -fsS http://127.0.0.1:3001/api/v1/projects \
  -H "Authorization: Bearer $HOTSPARK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-create-v1' \
  --data-binary @project.json
```

`project.json`:

```json
{
  "spec": {
    "apiVersion": "hotspark.dev/v1",
    "kind": "Application",
    "metadata": { "name": "example-app" },
    "services": {
      "web": {
        "type": "nextjs",
        "source": {
          "type": "git",
          "repository": "https://github.com/example/app.git",
          "commit": "0123456789abcdef0123456789abcdef01234567"
        },
        "build": {
          "nodeVersion": "24",
          "packageManager": "npm",
          "buildCommand": ["npm", "run", "build"],
          "standalone": true
        },
        "runtime": { "port": 3000 },
        "database": "database",
        "hooks": [{ "type": "prisma-migrate-deploy" }],
        "domains": ["app.example.com"],
        "environment": { "APP_LABEL": "Example" },
        "resources": { "cpus": 1, "memoryMb": 512 }
      },
      "database": { "type": "postgres", "version": "17" }
    }
  }
}
```

Response: `202 {"projectId":"<uuid>","jobId":"<uuid>","job":{...}}`. Poll GET `/api/v1/jobs/<jobId>` until `succeeded`, `failed` or `cancelled`. Successful creation provides a healthy stack and dynamic routing, not a public DNS record. `DATABASE_URL` is generated and delivered without returning credentials in project reads.

An idempotency key replays the original response for the same authenticated user and input. Reusing it with a different request yields 409. Keep keys stable when retrying a timed-out mutation; use a new key for a new intended change. Authorization is checked before replay. Keys currently have no automatic retention policy.

## Resources

| Endpoint                                                   | Behavior / permission                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET `/projects`                                            | Up to 100 current projects; projects:read                                                                  |
| POST `/projects`                                           | Create envelope above; projects:create, plus domains:manage when exposing domains                          |
| GET `/projects/:id`                                        | Spec, desired/observed state and metadata; no secret values                                                |
| PATCH `/projects/:id`                                      | `{spec?,secrets?,restoreOnDrift?}`; projects:update; changing domains additionally requires domains:manage |
| DELETE `/projects/:id`                                     | Asynchronous removal preserving persistent data; projects:delete                                           |
| POST `/projects/:id/start`, `/stop`, `/restart`, `/deploy` | Asynchronous lifecycle; projects:update                                                                    |
| GET `/projects/:id/services`                               | Service metadata                                                                                           |
| GET `/projects/:id/runtime`                                | Agent runtime inspection                                                                                   |
| GET `/projects/:id/logs?service=web&lines=200&stream=both` | Bounded stdout/stderr/both; logs:read                                                                      |
| GET `/projects/:id/domains`                                | Domain reservations                                                                                        |
| PUT `/projects/:id/domains`                                | `{service:"web",domains:["app.example.com"]}`; projects:update and domains:manage; queues deployment       |
| GET `/jobs/:id`                                            | Status, progress, attempts, bounded events; projects:read                                                  |
| POST `/jobs/:id/cancel`                                    | Cancel unstarted queued work; projects:update; remove jobs also need projects:delete                       |
| POST `/jobs/:id/retry`                                     | Retry terminal failure where safe; projects:update; remove jobs also need projects:delete                  |
| GET `/dashboard`                                           | Counts, platform readiness and host memory/load/disk statistics                                            |

All paths in this table are prefixed `/api/v1`. Project mutation responses are 202 job references. Concurrent work on the same project returns 409. An active domain reservation cannot be claimed by another project, including during a failed deployment/removal.

Errors use `{error:{code,message,requestId}}` with appropriate 400/401/403/404/409/429/500 status. Job errors deliberately omit subprocess output and credentials. Logs are tail retrieval, not an unbounded stream: maximum 1,000 lines, 256 KiB output and a ten-second subprocess bound. Default project listings and reconciliation are capped at 100 projects in this early release; pagination and large installations need further work.

## Immutable releases (0.3)

- `POST /projects/:id/deployments`: queue a new build from current project intent (`projects:update`).
- `GET /projects/:id/deployments`: release history (`projects:read`).
- `GET /deployments/:id`: metadata, timeline, health, active relationship (`projects:read`).
- `GET /deployments/:id/logs`: bounded redacted build/migration output (`logs:read`).
- `POST /deployments/:id/cancel`: request pre-migration cancellation (`projects:update`).
- `POST /projects/:id/rollbacks` with `{"deploymentId":"UUID"}`: queue image reuse, no migration replay (`projects:update`, plus `domains:manage` when domain intent changes).
- `PUT /projects/:id/maintenance` with `{"enabled":true}`: queue manual maintenance (`projects:update`).

All paths above are relative to `/api/v1`. Mutations return asynchronous job references. Use `Idempotency-Key` for retryable mutation requests. Poll `/jobs/:id`; successful deployment jobs select a new `activeDeploymentId`. A failed newer attempt does not replace it. Deployment errors do not imply the prior release is offline.

Example Next.js + PostgreSQL creation (replace the repository and domain):

```bash
curl -fsS "$HOTSPARK_URL/api/v1/projects" \
  -H "Authorization: Bearer $HOTSPARK_TOKEN" \
  -H 'Idempotency-Key: create-shop-001' \
  -H 'Content-Type: application/json' \
  --data-binary @project.json
```

```json
{
  "spec": {
    "apiVersion": "hotspark.dev/v1",
    "kind": "Application",
    "metadata": { "name": "shop" },
    "deployment": { "maintenance": "during-migrations" },
    "services": {
      "web": {
        "type": "nextjs",
        "source": {
          "type": "git",
          "repository": "https://github.com/example/shop.git",
          "branch": "main"
        },
        "build": {
          "packageManager": "npm",
          "nodeVersion": "24",
          "standalone": true
        },
        "runtime": {
          "port": 3000,
          "healthcheck": {
            "type": "http",
            "path": "/api/health",
            "intervalSeconds": 5,
            "timeoutSeconds": 3,
            "retries": 12
          }
        },
        "database": "database",
        "hooks": [{ "type": "prisma-migrate-deploy", "phase": "migration" }],
        "domains": ["shop.example.com"]
      },
      "database": { "type": "postgres", "version": "17" }
    }
  }
}
```

The repository must enable Next standalone output, include a lockfile, generate its Prisma client during build, and commit migrations. Database credentials and `DATABASE_URL` are generated automatically. For a new revision, PATCH the specification or queue `/projects/:id/deployments` to resolve the branch again. Start/stop/restart do not resolve Git or build.

## Operations (0.4)

See [automation](api-automation.md) for a complete machine-driven workflow and [monitoring](monitoring.md) for authenticated doctor/metrics. Operational mutations under `/api/v1/system/` require `admin`, return `taskId` asynchronously and support idempotency keys. Poll `/api/v1/system/tasks/:id`; task success is distinct from request acceptance. Monitoring accepts `system:read`. Project resource usage uses `/api/v1/projects/:id/usage`. All CLI operations use these public routes.
