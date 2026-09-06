# ApplicationSpec and DeploymentPlan

ApplicationSpec `hotspark.dev/v1` is the shared high-level schema used by the API, SDK and UI. Unknown fields are rejected. Names use lowercase letters, digits and hyphens, starting with a letter, up to 40 characters. Hostnames normalize to lowercase; wildcard/IP domains are not accepted. Project UUIDs and Docker resource identifiers are generated independently from display names.

See [API examples](api.md) for a complete Next.js + PostgreSQL request and [providers](service-providers.md) for build/runtime options. Creation wraps intent as `{spec,secrets?}`. Secret values are separate from the spec; `database` links a Node/Next service to a same-project PostgreSQL service. No raw Compose, host mount, privileged flag or generic shell API is accepted.

```mermaid
flowchart LR
  Spec[ApplicationSpec v1] --> Validate[Shared strict schema]
  Validate --> Plan[DeploymentPlan v2]
  Plan --> Secrets[Agent secret materialization]
  Secrets --> Compose[Generated Compose]
  Compose --> Docker[BuildKit and Docker runtime]
```

The pure provider compiler canonicalizes the spec and sorts service entries. Plans contain spec hash, generated Compose project/service IDs, networks/volume references, provider build templates, pinned image references and Git commits. The agent resolves build output image IDs and stores immutable deployment plan snapshots plus the active plan/current pointer under the project's deployment directory. Random credentials are generated outside the deterministic compiler and stored encrypted separately.

CPU limits range from 0.1 to 8 CPUs; memory limits range from 64 to 8192 MiB, defaulting to one CPU and 512 MiB per service. These are runtime controls, not build quotas or total project admission control. Disk quotas are not implemented. Read-only root filesystems default on where practical; PostgreSQL writes its named volume and managed Node applications can explicitly opt into ephemeral writable roots.

New projects use internal plan version 2. Legacy plan version 1 resources remain inspectable and startable/stoppable, but editing/redeployment is blocked until a reviewed migration preserves their database volume mapping. Internal plan versions are not part of the public request API.

For immutable deployments, Git sources accept `commit`, `branch`, or `tag`; the agent resolves a commit before producing an executable plan. A supplied commit takes precedence. `deployment.maintenance` is `never`, `during-migrations`, or `entire-deployment`. `runtime.healthcheck` configures HTTP path and bounded retries using seconds. See the complete [API example](api.md#immutable-releases-03) and [deployment semantics](deployments.md).
