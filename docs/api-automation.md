# Browserless automation

Use the public OpenAPI document at `/api/v1/openapi.json` (committed copy: `docs/openapi.json`) for tool generation. UUIDs identify resources; names express intent. Authentication is bearer-only. Never send Compose, host paths or shell commands.

Authenticate with `POST /api/v1/auth/login` and `{ "email": "admin@localhost", "password": "..." }`, then create a short-lived scoped token using `POST /api/v1/tokens`. Provisioning needs `projects:create`, `projects:read`, `projects:update`, and `domains:manage`; add `logs:read` for log access. Operational backups/updates require `admin`; doctor/metrics support a dedicated `system:read` token. Tokens are shown only on creation; store them securely. Use HTTPS or SSH loopback forwarding.

```bash
export HOTSPARK_URL=https://YOUR_ADMIN_HOST
# Supply HOTSPARK_TOKEN through your secret manager, not shell history.
curl --fail-with-body "$HOTSPARK_URL/api/v1/projects" \
  -H "Authorization: Bearer $HOTSPARK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-create-001' \
  --data-binary @project.json
```

`project.json` (replace repository/domain with your reviewed application):

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
          "branch": "main"
        },
        "runtime": { "port": 3000 },
        "domains": ["app.example.com"],
        "database": "database"
      },
      "database": { "type": "postgres", "version": "17" }
    }
  }
}
```

Creation returns HTTP 202 with `projectId`, `jobId` and `deploymentId`. Poll `GET /api/v1/jobs/:jobId` every few seconds until `succeeded`, `failed` or `cancelled`. Do not equate acceptance with readiness. On success, read `GET /api/v1/projects/:projectId`, verify the expected `activeDeploymentId`, inspect `GET /api/v1/deployments/:deploymentId` for commit/image/health, then make a real HTTPS request to the domain. PostgreSQL remains on the private bridge and the web service receives `DATABASE_URL` through a generated secret file.

Configure Next standalone output explicitly where supported; see [providers](service-providers.md) and the exact schema for package manager, commands and fixed Prisma migration hooks. The example repository is illustrative and is not claimed to exist.

```bash
curl --fail-with-body -X POST "$HOTSPARK_URL/api/v1/projects/PROJECT_UUID/deployments" \
  -H "Authorization: Bearer $HOTSPARK_TOKEN" -H 'Idempotency-Key: deploy-main-002'
# Poll its new job ID, verify immutable commit/image and HTTP response again.
```

`PATCH /projects/:id` submits the full new specification and queues a new deployment. Start/stop/restart reuse the active release; rollback accepts `{ "deploymentId": "PREVIOUS_UUID" }` at `POST /projects/:id/rollbacks`. Maintenance uses `PUT /projects/:id/maintenance` with `{ "enabled": true }`. Database rollback is never implied.

Errors have `{ "error": { "code", "message", "requestId" } }`. Handle 401/403 credentials/scopes, 409 concurrent operation/domain/idempotency conflict, and 429 backoff. Idempotency is bounded to seven days; reuse a key only for exactly the same mutation. Lists currently return at most 100 resources; persist UUIDs in your automation. CLI log following is bounded polling, not a lossless event stream.
