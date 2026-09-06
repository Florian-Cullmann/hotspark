# Security model

Docker isolation is **not equivalent to a VM security boundary**. All hosted applications share the host kernel. The Docker socket grants effectively root-level host control; only the agent receives it. The agent is part of the trusted computing base even though its own container drops capabilities and does not use `privileged: true`.

## Supported threat model

The initial platform is operated by trusted administrators hosting reviewed workloads. It prevents normal API users from directly choosing arbitrary shell commands, Compose, host networking, bind mounts or privileged flags. It does not safely sandbox malicious Dockerfiles or protect hostile tenants from every shared-kernel, network, resource-exhaustion or container-runtime vulnerability.

Projects have distinct Compose names, private bridge networks, secrets directories and volumes. Databases have no published ports and no proxy membership. Only intentionally exposed HTTP containers join the shared proxy bridge. Those containers can reach each other on that shared bridge. Private bridge separation also does not provide a complete egress firewall: containers can reach internet and reachable host services. Stronger cross-project enforcement needs per-project proxy attachments or host firewall policy and is a prerequisite for hostile tenants.

Runtime web containers use uid/gid 10001, read-only root filesystems by default (configurably writable for compatible applications), a bounded `/tmp`, no capabilities, `no-new-privileges`, PID/memory/CPU limits and bounded local logs. Images must support these constraints and listen on a port >=1024. PostgreSQL uses its official entrypoint and the capabilities necessary to initialize volume ownership; hosted PostgreSQL then runs as uid 999. Control-plane PostgreSQL runs as uid 10001 from startup. No runtime service uses host networking.

BuildKit builds use public GitHub repositories pinned by commit. Builds can execute arbitrary Dockerfile RUN instructions inside BuildKit and have default build-network egress. New workload builds share a bounded dedicated builder (4 GiB, two CPUs, 2048 PIDs). Per-build fairness and a restrictive fetch proxy are not implemented. Do not accept unreviewed repositories from anonymous users. A pinned source commit does not make builds bit-reproducible: dependencies and Dockerfile base images must also be locked. Third-party OS packages used to build platform images currently track the configured apt repositories; release image distribution is a future improvement.

## Credentials and authorization

- Passwords use asynchronous scrypt, N=131072, r=8, p=1, unique random 16-byte salts and timing-safe comparison.
- API tokens contain 32 random bytes; only SHA-256 digests are stored. Random tokens do not need a slow password KDF. Tokens expire and can be revoked.
- `projects:read`, `projects:create`, `projects:update`, `projects:delete`, `logs:read`, `domains:manage`, `admin` scopes (plus legacy `read`/`deploy` aliases) are enforced at API routes. `admin` includes every scope. Token creation/revocation requires `admin`.
- All authenticated users currently require the admin role. Do not infer multi-user isolation from the presence of user IDs.
- Sessions are eight-hour bearer tokens. The UI keeps them only in React memory, not local storage or cookies. “Clear session” now revokes the current token through the public logout endpoint before clearing browser state. Cookie login and CSRF policy remain future work.
- Administration binds to host loopback. Use SSH forwarding initially. Do not expose it over unencrypted public HTTP.

Root-only secret parent directories prevent host users from traversing them. Platform secret files are mode 0400, owned by the non-root service uid 10001 for container access; hosted database password files use uid 999. Compose file secrets are bind-mounted files, not an encrypted secret store. Application passwords do not appear in generated Compose or API responses. Local root and Docker administrators can read all secrets. User secrets and generated credential vaults use AES-256-GCM at rest; plaintext delivery files live only under `/run/hotspark-secrets`. Backup encryption and secure key storage remain operator responsibilities. See [secrets](secrets.md).

Request logs redact authorization headers, passwords, and token fields. Raw database exceptions, Docker output, and build logs are not returned or logged because these can contain credentials. Lifecycle audit events include actor, action, resource ID, request ID and time, and commit with metadata mutations. The initial audit table is not tamper-proof and does not yet record every denied request.

Fastify bounds request bodies and applies in-process rate limiting; login has a separate limit. Do not trust forwarded IP headers from arbitrary clients. Requests rewritten by Next.js share the web container's source IP, so the limit is conservative and can affect multiple clients together. Distributed rate limits and secure proxy identity handling must precede horizontal scaling.

## Operational baseline

Keep the OS and Docker patched; restrict SSH; do not add untrusted users to the Docker group. Back up metadata, project volumes, generated secrets and ACME data. Test recovery on a separate host. Public routing consumes ports 80/443. The proxy has no Docker socket and no public dashboard. Review dependency upgrades; `npm audit` is part of CI. The lockfile overrides `deepmerge-ts` and `esbuild` to patched versions; Prisma generation/migrations and production builds validate their compatibility.

Report security defects privately to the repository maintainers through GitHub private vulnerability reporting when a public repository is established. No security contact or signing identity has been invented for this initial checkout.

Operational tasks, backup/update trust and remaining risks are detailed in [threat model](threat-model.md). Audit events now retain 180 days; backups remain root-only but unencrypted.
