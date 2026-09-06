# Versioned platform updates

Configure `/etc/hotspark/releases.json` as root:

```json
{ "baseUrl": "https://YOUR-TRUSTED-RELEASE-HOST/releases" }
```

A private HTTPS mirror can use an administrator-provided `/etc/hotspark/release-ca.pem`; TLS verification is never disabled. Review `release-policy.json` for every version before packaging. The release origin is not accepted from API clients. A release contains `vVERSION/release.json` and `vVERSION/hotspark-VERSION.tar.gz`. Supply an independently trusted archive SHA-256:

```bash
platform update 0.4.1 --sha256 TRUSTED_64_HEX_DIGEST
platform task RETURNED_TASK_UUID
```

The public API is `POST /api/v1/system/updates` with `{ "version": "0.4.1", "sha256": "..." }`. It requires `admin`; acceptance returns a durable task, not an update success.

Updates require an idle application/operational queue. A PostgreSQL advisory gate rejects new lifecycle and operational mutations with 409 while an update is queued/running. Installation, uninstall and the update runner share a persistent host lock. The agent launches a separate runner from its installed immutable image. This privileged runner holds a persistent update lock and survives replacement of API/agent containers. It fetches metadata over HTTPS, checks the requested version/checksum and explicit `upgradeFrom` list, and permits only releases declaring backward-compatible platform database migrations. It verifies the downloaded archive before extracting trusted release code into a new version directory. Existing release directories are never overwritten.

It builds target platform images before stopping the API/worker, makes a custom-format database backup and validates its TOC and checksum, runs Prisma migrations, changes only platform containers, waits for Compose health checks, then advances `/opt/hotspark/current`. The installed `platform` command is a stable symlink into that versioned release, so it changes with the same health-gated pointer. Hosted applications, private networks and data volumes are untouched. Routing can briefly interrupt when the proxy image/configuration changes. Updates require spare disk and build memory.

On ordinary failure, it restores the old version configuration and tries to start the prior platform images. The database is never automatically restored; backward-compatible migration declarations must be reviewed during release publication. Backup manifests and old release files/images are retained. Failed/interrupted staged releases require root review before retrying that version; the runner refuses to overwrite a staged directory. If the host dies during a migration, the task is classified as interrupted and requires inspection; there is no claim of transactional filesystem/PostgreSQL activation.

A v0.3 installation has no update endpoint. Its first upgrade requires the documented versioned staging/migration procedure; later v0.4 updates use this API. No real public release host, signing identity or published 0.4.1 is implied by the example. Checksums obtained from a compromised origin are not publisher authentication. Signature verification can be inserted before the archive extraction boundary.
