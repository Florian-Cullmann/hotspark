# Database migration policy

Prisma is application tooling, not an infrastructure service. An application with `database: database` receives a generated `DATABASE_URL` through its runtime secret loader. The PostgreSQL service remains private and has no published ports.

Supported hooks are structured:

```json
[
  { "type": "image-check", "phase": "preDeploy" },
  { "type": "prisma-migrate-deploy", "phase": "migration" },
  { "type": "http-health", "phase": "postDeploy" }
]
```

The Prisma hook runs the fixed Prisma `migrate deploy` operation in an ephemeral container using the separately built migration image, the project network, and runtime credentials. The image may execute repository-owned migration code: deployment permission is a code-execution trust decision within the application's isolation boundary. There is no arbitrary host-shell endpoint.

Each migration hook records started/completed checkpoints. An interrupted hook has an uncertain outcome and is never replayed automatically; inspect the database and Prisma migration history before submitting another deployment. A new explicit deployment may run the declared hooks again, so applications must use migration tooling with its own durable history.

Use expand/contract changes: add compatible schema first, deploy compatible code, migrate data, then remove obsolete schema in a later controlled release. Maintenance prevents external HTTP access but does not suspend internal workers or the previous release's background activity. It cannot make incompatible migrations safe. Back up databases independently and test restores. Automatic database rollback is intentionally absent.
