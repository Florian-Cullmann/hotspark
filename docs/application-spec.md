# ApplicationSpec v1

The public API accepts JSON validated by `packages/application-spec`. YAML is shown here for readability; it must be converted to JSON before submission. Unknown keys are rejected. Compose YAML is never accepted by normal API routes.

```yaml
apiVersion: hotspark.dev/v1
kind: Application
metadata:
  name: example-app
services:
  web:
    type: nextjs
    source:
      type: git
      repository: https://github.com/example/app.git
      commit: 0123456789abcdef0123456789abcdef01234567
    runtime:
      port: 3000
      healthPath: /health
    domains:
      - app.example.com
    resources:
      memoryMb: 512
      cpus: 1
  database:
    type: postgres
    version: "17"
    image: postgres:17@sha256:86e0b703649d7a792bd9243ee28afc9d8f7c6b2b5638077c9d6882d4d472bbfd
```

The Git example is illustrative; its repository/commit are placeholders. Production plans require real full commits. Mutable branches and tags are not accepted. An image source instead uses `type: image` and `image: registry/path@sha256:<64 hex characters>`.

Names are lowercase DNS-like identifiers, 1–40 characters. UUIDs come from the platform, not metadata names. Applications contain 1–20 services. Web/Next.js services use ports 1024–65535, up to ten lowercase ASCII domains, optional health paths and bounded CPU/memory requests. Wildcards, arbitrary routing expressions, credentials in image URLs, custom ports in registries, environment variables, Docker flags and host paths are not supported. Postgres v1 supports only version 17 with an official digest-pinned image reference.

`nextjs` currently denotes the web runtime contract; it does not auto-detect framework versions or generate a buildpack. Git repositories need a Dockerfile at their root producing an HTTP image compatible with uid 10001, read-only root and `/tmp` as its writable scratch directory. Listen on `0.0.0.0:$PORT`. Pin Dockerfile base images and lock dependency resolution for reproducible builds. Private repositories and build secrets are not supported yet.

PostgreSQL receives database/user `app`, a generated password through a project-specific file secret, and its own persistent named volume. Database integration into web application configuration is not automatic in this first foundation. A typed connection/secret-delivery adapter is still required; do not put a database password into a Dockerfile or image. This limitation is explicit rather than exposing an arbitrary environment/secret escape hatch.

## API workflow

1. `POST /api/v1/auth/login` with email/password; retain the returned bearer token securely.
2. `POST /api/v1/projects` with the ApplicationSpec; obtain a project UUID.
3. `POST /api/v1/projects/:id/deploy`; receive HTTP 202 and a job UUID.
4. Poll `GET /api/v1/jobs/:id` until `succeeded` or `failed`.
5. Use `POST /api/v1/projects/:id/start` or `/stop` independently.

Project specs are immutable in this initial API; editing/versioning is a pending API addition. Deployment snapshots are always immutable. The API also lists project services, domains, jobs and deployments; manages scoped tokens and revocation; and lists audit events. The [OpenAPI contract](openapi.json) is generated with `npm run openapi`. The SDK and UI reuse the same schema package; future CLI and AI clients can consume it or OpenAPI.

Only project metadata and domain reservation happen on create. Deploy is explicit. A successful job means Compose completed and routing configuration was published, not that all business functionality or external DNS/certificates have been validated.
