# Installation and lifecycle

Supported host: fresh, fully updated Debian 13 with systemd, root access, amd64 or arm64, outbound HTTPS and enough disk/memory for Docker builds. No host Node.js, Docker or PostgreSQL is assumed. Reserve at least 4 GiB RAM and 20 GiB free disk for initial builds. Ports 3000/3001 bind only to loopback; 80/443 are public routing ports.

## Install from this checkout

```bash
sudo env HOTSPARK_SOURCE_DIR="$PWD" sh installer/install.sh
```

The script has a POSIX wrapper and passes its literal body to Bash, where `set -Eeuo pipefail` applies. Both `sh installer/install.sh` and a streamed `curl | sudo sh` entrypoint are supported. It validates root, OS, architecture and systemd; locks against concurrent installation; installs minimal OS dependencies, including Git before Docker first starts so BuildKit can fetch Git contexts; installs Docker Engine, Buildx and Compose from the official Docker apt repository; starts/enables Docker; creates directories, secrets and the proxy network; builds versioned platform images inside Docker; starts PostgreSQL; applies committed Prisma migrations; starts all containers and waits for health; then advances `/opt/hotspark/current` and prints access instructions. It does not remove conflicting preinstalled Docker packages or reset an existing daemon; use the specified fresh host.

Validation without changes:

```bash
sudo sh installer/install.sh --validate-only
```

Existing secrets, configuration and database contents are preserved. Repeating an installation with the same version reuses its staged release directory. It can update Docker packages through apt and re-check/rebuild images. It is not a transactional OS installer; a failed run can leave packages and containers installed, with data preserved. Investigate the reported failure and rerun. To change source code during development, test a new release version or deliberately replace the disposable test release; never silently mutate a published release.

## Published releases

There is no public release host yet. `example.org` is a placeholder. `scripts/release.sh` creates a versioned tarball and `SHA256SUMS`. An actual release must assign a permanent hosting URL, trusted checksum distribution, signing identity, license attribution, SBOM and image provenance.

```bash
curl -fsSL https://YOUR-RELEASE-HOST/install.sh -o install.sh
# Review install.sh and verify its signature/checksum using independently trusted metadata.
sudo env HOTSPARK_VERSION=0.1.0 \
  HOTSPARK_RELEASE_BASE_URL=https://YOUR-RELEASE-HOST/releases \
  HOTSPARK_RELEASE_SHA256=TRUSTED_64_CHARACTER_HEX_DIGEST \
  sh install.sh
```

The archive URL is `<base>/v<version>/hotspark-<version>.tar.gz`. Archives have repository contents at their root. The installer requires HTTPS and an explicit trusted archive checksum before extraction. Checksums downloaded from the same compromised origin provide no publisher authentication. A future signature verifier can run before the same extraction step. The one-line UX can be published once release defaults and trust metadata are set; this checkout does not pretend that an endpoint already exists.

## Paths

| Path                                 | Purpose / permissions                                                      |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `/etc/hotspark/platform.env`         | Operator configuration, no passwords                                       |
| `/etc/hotspark/traefik.yaml`         | Static proxy configuration                                                 |
| `/etc/hotspark/secrets/`             | Root-only directory; service-owned 0400 files                              |
| `/var/lib/hotspark/database/`        | Control-plane PostgreSQL data                                              |
| `/var/lib/hotspark/projects/<UUID>/` | Root-only generated Compose, plans, secrets, current pointer               |
| Docker named volumes `hs-<UUID>_*`   | Hosted PostgreSQL data                                                     |
| `/var/lib/hotspark/routes/`          | Agent-written, proxy-readable dynamic routes                               |
| `/var/lib/hotspark/acme/`            | uid 10001, 0700, certificate account state                                 |
| `/run/hotspark/agent.sock`           | root:10001, 0660 local agent endpoint                                      |
| `/etc/tmpfiles.d/hotspark.conf`      | Restores runtime directory after reboot                                    |
| `/opt/hotspark/releases/<version>/`  | Root-owned versioned release files                                         |
| `/opt/hotspark/current`              | Last successfully installed release                                        |
| `/var/log/hotspark/`                 | Reserved exported diagnostics; normal logs use bounded Docker local driver |

No project data is stored under the release directory. Restart policies and systemd-enabled Docker restore containers on boot.

## Access and HTTPS

```bash
ssh -L 3000:127.0.0.1:3000 root@SERVER
# On the server:
cat /etc/hotspark/secrets/admin_password
platform doctor
```

Sign in at <http://localhost:3000> as `admin@localhost`. Changing the bootstrap file does not rotate an existing database password or administrator login.

To enable public application HTTPS, configure DNS and inbound TCP 80/443, and merge these settings into `/etc/hotspark/traefik.yaml`:

```yaml
entryPoints:
  web:
    address: ":8080"
    http:
      redirections:
        entryPoint:
          to: ":443"
          scheme: https
  websecure:
    address: ":8443"
certificatesResolvers:
  letsencrypt:
    acme:
      email: YOUR_EMAIL
      storage: /acme/acme.json
      httpChallenge:
        entryPoint: web
```

Keep the existing `health` entrypoint, `providers`, `ping` and `log` settings. Set `TLS_ENABLED=true` in `platform.env`, then recreate agent and proxy with the production Compose command. Redeploy applications to regenerate TLS routes. Static TLS setup needs this one-time restart; normal domain routing changes use Traefik file watching. Use Let's Encrypt staging while testing. Certificate issuance requires real, reachable domains and is not exercised by localhost tests.

## Updates and recovery

`platform update` currently exits with an explicit unsupported message; it never rewrites the running installer. Before a manual update, stop the API/worker, take a consistent PostgreSQL dump and back up hosted volumes/secrets. Stage a new version under `/opt/hotspark/releases`, build its images, review/apply migrations, update the configured version and run health checks using that release's Compose file. Advance `current` only after success. Database migrations may not be backward-compatible; reverting an image is not a database rollback. Restore from a verified backup when necessary.

Inspect `docker compose --env-file /etc/hotspark/platform.env -f /opt/hotspark/current/deployments/compose.yaml logs --tail 100` for operational logs. Failed jobs require comparing their snapshot with generated plans and actual Docker state before retry. Builds/Compose changes are not rolled back automatically.

## Removal and data deletion

```bash
sudo platform uninstall --platform-only
```

This removes platform containers and internal Compose networks. It preserves configuration, release files, all platform/application data, external proxy network and hosted containers. Hosted apps continue running; HTTP routing stops because Traefik is removed. Reinstall the same release to restore the control plane.

Removing a hosted application is a separate root-only operation: identify its UUID, then run `docker compose -p hs-UUID -f /var/lib/hotspark/projects/UUID/compose.json down` and remove only its route file. This preserves named volumes and secrets. There is no destructive deletion API yet.

Persistent deletion is a third, deliberate step: after independently verified backups, enumerate that project's named volumes with Docker labels, review each volume name, and explicitly remove only those selected volumes and its secrets directory. Control-plane deletion separately concerns `/var/lib/hotspark/database`. No uninstall command uses `down --volumes`, `docker system prune`, or recursive application-data deletion. Metadata cleanup and retention APIs remain future work.

Upstream references: [official Docker Debian repository installation](https://docs.docker.com/engine/install/debian/), [Traefik file provider](https://doc.traefik.io/traefik/reference/dynamic-configuration/file/), [Prisma production migrations](https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/development-and-production).
