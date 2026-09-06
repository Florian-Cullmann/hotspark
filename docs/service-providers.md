# Service providers

The public spec describes intent. `packages/providers` owns deterministic templates and the versioned DeploymentPlan compiler; the agent owns filesystem, secret and Docker operations. Providers cannot add an arbitrary host command or bind mount through the API. Extend the discriminated spec, provider output and renderer together with rejection/isolation tests when introducing Redis, MariaDB, workers or cron.

| Type       | Production behavior                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `nextjs`   | Generated Node image; production build and start; optional Next standalone runtime                            |
| `node`     | Generated Node image; configured install/build/start argv                                                     |
| `react`    | Build assets using Node, then serve output directory with unprivileged nginx on 8080; SPA fallback            |
| `postgres` | Official digest-pinned PostgreSQL 16/17/18, generated credentials, health check and persistent private volume |
| `web`      | Compatibility provider for a digest-pinned image or reviewed repository root Dockerfile                       |

Managed JavaScript builds support Node 22/24, npm, pnpm 10 and Yarn 4. npm uses `npm ci`, pnpm `install --frozen-lockfile`, Yarn `install --immutable`. Commit the appropriate lockfile. Build defaults to `<manager> run build`; start defaults to `<manager> run start`. `installCommand`, `buildCommand` and `startCommand` are restricted argv arrays, not shell strings. Complex logic belongs in reviewed repository package scripts. Repository code and dependencies execute in the build container and remain trusted code.

Next standalone requires `output:"standalone"` in next.config and `build.standalone:true`; it starts `node server.js` from the traced output and copies static/public assets. Production runtime and migration images are separate. Standalone runtimes copy traced output; normal Node runtimes prune development dependencies. A conventional Next deployment can instead use `next start` through its production package script. Known development servers and watch commands are rejected; arbitrary repository scripts cannot be proven safe by static validation.

React/Vite uses `build.outputDirectory` (default `dist`). It serves static content with nginx, not a Vite dev/preview server. `runtime.port` does not override nginx's internal 8080 port. Ordinary environment variables are available during build; static public values are compiled into assets. Runtime secrets and database bindings are rejected for static applications.

Node/Next receive `PORT`, production `NODE_ENV`, a default `0.0.0.0` hostname, and runtime secret delivery. Listen on all interfaces and the configured port. The default root filesystem is read-only with writable bounded `/tmp`. Set `runtime.readOnly:false` when your application requires an on-disk cache; it is ephemeral container storage, not a persistent application volume. The API currently has no general application volume declaration. Health defaults to HTTP `/`; configure `runtime.healthPath` if needed.

## PostgreSQL and Prisma

A PostgreSQL service gets a generated database name, username, random password, health check and project-scoped volume. PG18 uses its changed parent data mount; earlier majors use their conventional data path. Changing a database major/name or removing it through a project update is rejected pending a deliberate data migration.

`database:"database"` on a managed Node/Next service injects a URL for that service's database. Prisma is an application dependency, not infrastructure. A hook `{type:"prisma-migrate-deploy"}` executes the installed Prisma CLI's `migrate deploy` command in a one-off application container after PostgreSQL is healthy, before normal application startup. It does not install a CLI dynamically, accept arbitrary shell or run migrations during image build. Commit your Prisma migration directory and generate the client during build. Applications that query production databases while pre-rendering must move those pages to runtime or use an appropriate build strategy.

## Reproducibility

Sources require an HTTPS public GitHub repository and a commit, branch or tag; every deployment resolves and records an immutable commit before building. Provider base images are digest-pinned in the catalog. Plans are canonical, versioned and inspectable, and successful builds record their resolved local image IDs. Lockfiles and frozen installs improve repeatability, but arbitrary package scripts/network access and apt repositories prevent a claim of bit-for-bit builds. Private repositories, alternate Git hosts, monorepo subdirectories, custom Node versions, Yarn Classic and custom build secret injection are not yet supported.
