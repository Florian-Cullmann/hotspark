# Verification record

Verified on 2026-09-06. This is an initial implementation validation, not a production security audit.

## Local checks

- Prettier formatting and format check passed.
- ESLint, shell syntax checks and both TypeScript configurations passed.
- 17 unit/schema/API/runtime tests passed.
- Installer validation passed for file and piped entrypoints, non-root execution, unsupported OS and unsupported architecture.
- Disposable PostgreSQL integration passed: committed migration, administrator login (including the bootstrap account), scoped token denial, domain uniqueness, concurrent deployment exclusion, audit persistence, token revocation, readiness and real HTTP SDK create/deploy calls.
- TypeScript production compilation and Next.js 16.3.4 standalone production build passed.
- OpenAPI regeneration and formatting passed.
- Release archive/checksum generation passed.
- `npm audit` reported zero known dependency vulnerabilities at verification time.

## Debian host checks

A fresh disposable Debian 13.6 amd64 host was bootstrapped with the installer. Docker Engine 29.8.0 and Compose 5.5.1 were installed from Docker's official repository. Node.js was not installed on the host.

All five platform containers became healthy. Host loopback UI/API access and `platform doctor` passed. Administration ports were bound to 127.0.0.1. Traefik's public ports were 80/443.

The host smoke test successfully:

1. Created and deployed two projects, each containing an HTTP image and PostgreSQL.
2. Served both projects through dynamic Traefik routing.
3. Stopped one project, observed HTTP 503, and confirmed the other remained available.
4. Restarted the stopped project and observed HTTP 200.
5. Exercised the Next.js same-origin API login rewrite.
6. Built and deployed a commit-pinned public Git repository through the typed API → job → agent → BuildKit path, then observed HTTP 200.

Additional operator checks confirmed that hosted databases had no proxy membership and a direct connection from one private project database network to another timed out. A Docker daemon restart restored running containers. Platform-only uninstall left hosted containers and data running. Subsequent reinstallation through a piped `sh` entrypoint restored all platform services. A database marker and platform-secret checksums were unchanged across removal/reinstallation.

Issues discovered during validation were fixed: JSON Schema dialect/default handling, Fastify OpenAPI registration order, local administrator email validation, SDK empty-POST headers, Traefik configuration permissions and file extensions, internal-network port publishing, and the host Git dependency required before Docker's first start for Git contexts.

## Not verified or not implemented

Arm64 installation has schema/image support but was not run on hardware. Real DNS, Let's Encrypt issuance, renewal and HTTPS redirects were not exercised. No browser automation, penetration testing, sustained load testing or backup restoration drill was performed. Git dependency resolution is not claimed to be bit-reproducible. Remote workers, multi-user isolation, automated updates/rollback, application spec editing, application database-secret connection adapters, public release hosting and signatures are not implemented. See the architecture and security documents for boundaries.

The smoke test intentionally leaves test projects and persistent data on the disposable server for inspection; it does not silently delete application data.
