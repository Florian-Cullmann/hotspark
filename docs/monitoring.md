# Monitoring and notifications

`GET /api/v1/system/doctor` requires a `system:read` or administrator token and returns a redacted diagnostic report: Docker version, expected platform container health, host load/memory/disk, proxy network, fixed public-source DNS resolution, ACME certificate count/expiry where readable, database size/reachability, stuck jobs/deployments and reconciliation freshness. Unknown checks are reported as unknown, not healthy. It does not expose host addresses, domains, repository URLs, environment variables or ACME keys. An unavailable database can prevent API authentication; use root Docker/systemd diagnostics in that case.

The System UI displays diagnostics, storage, tasks, backup results and update status. The dashboard shows queue depth, failed deployments and low-disk warnings. Docker storage figures include daemon-wide images/cache/volumes, not invented per-project hard quotas. Per-project usage includes Docker-reported volume sizes and live container CPU/memory/PID/network/block-I/O figures; these are measurements, not quotas.

Prometheus can scrape `/api/v1/system/metrics` using a dedicated `system:read` bearer token. Do not publicly proxy this endpoint without authentication. Metrics include projects by observed state, unhealthy applications, queue depth, deployment outcomes, completed deployment duration, measured successful build duration and agent health. They expose counts/enums only. Durations are summaries of retained database records, not a monotonic lifetime metric after metadata archival. Build time excludes Git checkout and includes provider/migration image builds and image resolution.

```yaml
scrape_configs:
  - job_name: hotspark
    metrics_path: /api/v1/system/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /run/secrets/hotspark_metrics_token
    static_configs:
      - targets: [YOUR_ADMIN_HOST]
```

## Retention

- Docker application/platform logs: local driver, three 10 MiB files per container (updater: two).
- Release logs: 1 MiB per release, bounded 256 KiB reads, latest 20/up to 14 days.
- Release journal events: at most 200 per release.
- PostgreSQL job events: 30 days after terminal execution.
- Audit events: 180 days; export before expiry if longer retention is required.
- Notification events: 30 days; idempotency responses: seven days.
- Terminal job detail: 30 days; operational task database results: 180 days (disk backup manifests remain).
- Terminal release snapshots: 180 days, preserving active/previous and the latest five successful records; agent disk journals remain recovery archives.
- Backup artifacts and agent disk metadata: preserved until explicit operator archival.

## Event adapters

Durable events cover deployment success/failure, rollback, application unhealthy, disk pressure, certificate expiry and backup failure. Poll `GET /api/v1/system/events`. Disk/certificate warnings are checked by the operational worker every minute and when doctor runs. Event IDs provide deduplication.

The optional generic webhook adapter is configured on the API with `NOTIFICATION_WEBHOOK_URL` and a `NOTIFICATION_WEBHOOK_KEY_FILE` containing at least 32 secret characters. Mount the file read-only using a reviewed Compose override. It sends only event identifiers, type, resource ID and timestamp; it does not send logs or secrets. HTTPS/public IPv4 port 443 destinations only, pinned vetted DNS, no redirects, ten-second timeout and at most five attempts. It is off by default. No third-party integration is a core dependency.

Verify `X-Hotspark-Signature: sha256=...` as HMAC-SHA256 over `X-Hotspark-Timestamp + '.' + rawBody`, enforce a replay window and deduplicate `X-Hotspark-Event-Id`. Delivery is at-least-once; a crash after delivery may repeat an event. Retry exhaustion leaves the event queryable. Other integrations implement the same `NotificationAdapter` interface.
