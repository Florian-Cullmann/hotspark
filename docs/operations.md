# Operating Hotspark

Hotspark remains early-stage, single-host software for trusted administrators and reviewed workloads. Keep the OS/Docker patched, maintain off-host backups, monitor free storage, and test recovery before relying on it.

## CLI

From a development checkout, build once and run `npm run cli -- help`. The installed `platform` wrapper supplies Node in a container, keeping the host free of Node.js. The wrapper requires root/Docker access; a workstation can execute the compiled CLI with Node 24 without Docker. All management commands use the public REST API. Only local `uninstall --platform-only` remains an explicitly host-local installation operation.

```bash
# Through an SSH tunnel, or use your HTTPS administration origin:
cat /etc/hotspark/secrets/admin_password | platform login http://127.0.0.1:3001 --password-stdin
platform project list
platform project create app.yaml
platform deploy my-app
platform logs my-app --service web --follow
platform stop my-app
platform start my-app
platform restart my-app
platform maintenance enable my-app
platform maintenance disable my-app
platform rollback my-app
platform backup my-app
platform doctor
platform gc my-app                 # dry run
platform gc my-app --apply --retain 5
platform logout                    # revokes the current session server-side
```

`platform login https://YOUR_ADMIN_HOST` prompts for a password without echoing it. Use `--token-stdin` for scoped API tokens. `HOTSPARK_URL` and `HOTSPARK_TOKEN` support automation without a saved login. Saved credentials use owner-only files/directories. Never put passwords in command arguments. Bearer credentials require HTTPS except on loopback/SSH tunnels. Following logs polls bounded history every three seconds; it is not lossless streaming, and terminal control bytes are stripped. Use project UUIDs when a name is outside the first 100-project listing.

## Garbage collection and storage

GC is explicit, administrator-only and dry-run by default. It locks the project against deployment/backup, protects active and previous releases plus a configurable count of successful historical releases, checks container references, and removes only unused images bearing the platform/project ownership label. Docker removal is never forced. It removes completed temporary workspaces and unretained disk logs, preserves release metadata and **never deletes volumes**. A collected image may no longer be a rollback target. Image deletion failure is a failed task, not success.

New workload builds use a platform-owned BuildKit builder with a 4 GiB memory, two-CPU and 2048-PID ceiling shared across builds. `platform gc PROJECT --build-cache --apply` prunes only its unused cache older than seven days, retaining at least 2 GB. The pre-existing shared daemon cache is reported but never pruned because ownership is not established. Do not run `docker system prune -a`. Retained image IDs and backup artifacts still need capacity planning and explicit archival. Workload memory/CPU defaults are 512 MiB/1 CPU, configurable within schema bounds; PID limit is 256. These are runtime limits, not complete build or host resource budgets. No hard disk quotas exist.

## Reboot

Docker is systemd-enabled; platform and application containers use `unless-stopped`. The agent reconstructs tmpfs secrets, recovers pending releases and republishes routes. Reconciliation restores desired running stacks where safe. Intentionally stopped stacks retain desired state and remain stopped. Interrupted migrations are never blindly replayed. See [recovery](recovery.md).

## Firewall

Use a provider firewall first: permit SSH on the administrator's actual port/source, and HTTP/HTTPS 80/443. Keep the existing SSH session open and test a second connection before removing any access rule. Never flush host rules or assume SSH uses port 22. The installer does not rewrite SSH authentication or activate a firewall behind the administrator's back.

Docker manages forwarding/NAT rules. UFW alone does not filter published Docker ports reliably; see [Docker firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/) and [DOCKER-USER rules](https://docs.docker.com/engine/network/firewall-iptables/). Administration binds to loopback, databases publish no ports, and only Traefik publishes 80/443. If adding host policy, preserve Docker forwarding, established connections, loopback, DHCP/IPv6 neighbor discovery, and the actual SSH port. Review both IPv4 and IPv6 and verify externally. A universal automatic firewall rewrite is intentionally avoided to prevent SSH lockout.
