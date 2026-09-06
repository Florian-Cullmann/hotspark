# Host agent protocol

The control plane sends `POST /v1/operations` over `/run/hotspark/agent.sock`. The JSON operation union lives in `packages/application-spec`; the agent validates it independently. Socket ownership is root:10001 with mode 0660, its directory is root-owned, and requests require a random bearer token compared in constant time. The API receives the socket directory read-only and a token secret file. Neither API nor UI receives the Docker socket.

Operations are `deploy`, `start`, `stop`, `restart`, `remove`, `inspect`, `logs`, `host-info`, `operation-status`, `maintenance`, `deployment-details`, and `cancel-deployment`. Deploy includes `projectId`, `operationId`, `deploymentId`, validated `spec` and an authenticated encrypted secret snapshot. Lifecycle mutations include UUID project and operation IDs. Inspect/logs require a project ID; logs optionally select a validated service, stdout/stderr/both and at most 1,000 lines. BuildService is internal to deploy so callers cannot build arbitrary host paths or bypass deployment validation.

```json
{
  "operation": "stop",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "operationId": "22222222-2222-4222-8222-222222222222"
}
```

One mutation executes at a time. Read-only inspection/progress calls remain available. Busy returns 409. A durable request-hash journal makes completed mutations idempotent and rejects reuse of an operation ID with different input. Results omit secrets and raw subprocess errors. There is no `executeShell`, raw Compose input or general Docker API passthrough.

Docker commands use a fixed executable and argument arrays, bounded output and timeouts. Provider build/start commands are argv data executed inside the generated application image; they are not executed by a host shell. Structured hooks include fixed image checks, Prisma migrations, and HTTP health checks. The repository itself remains trusted executable code.

Remote agents should implement the same versioned intent protocol with mutually authenticated TLS, host identities, placement/capability negotiation and per-host scheduling. Do not expose the current Unix protocol over TCP. Encryption-key distribution and rotation must be designed before remote workers are enabled.

Release execution uses per-project persistent OS locks, allowing separate projects to run concurrently. Read-only inspection and pre-build cancellation remain available during deployment. Agent responses expose bounded redacted logs and release metadata, never plaintext vaults. See [recovery](recovery.md).
