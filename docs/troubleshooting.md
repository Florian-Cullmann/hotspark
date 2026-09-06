# Troubleshooting

Start with `platform doctor` and the System UI. Share the redacted report and version in an issue. Do not attach `/etc/hotspark/secrets`, backups, raw Docker inspect output, authentication headers, database URLs or unreviewed build logs.

- **API unavailable:** `systemctl is-active docker`, then `docker compose --env-file /etc/hotspark/platform.env -f /opt/hotspark/current/deployments/compose.yaml ps`. Inspect bounded logs with `logs --tail 100 api agent database proxy`. Review locally for secrets before sharing.
- **401/403:** token expired/revoked or missing scope. Login again or issue a narrowly scoped token. Clearing local state alone is not revocation; `platform logout` revokes the session.
- **409:** another project operation is queued/running, domain is reserved, or an idempotency key was reused with different input. Poll the existing job; do not bypass locks.
- **Deployment failed but traffic works:** the latest attempt differs from the active release. Inspect its health/events. Never assume an application rollback reverted database changes.
- **Maintenance after failure:** no previous healthy release may exist, or manual maintenance remains enabled. Inspect active state and database/migration outcome before changing it.
- **Disk warning:** back up first, review `platform gc PROJECT` dry-run, retain rollback history, then apply deliberately. Never run global Docker prune or delete database volumes to recover space.
- **Docker address pools exhausted:** repeated fixture projects allocate bridge subnets. Remove unused fixture projects through the API (volumes are retained), or plan non-conflicting daemon address pools during a maintenance window. Do not delete live project networks.
- **Backup failed:** inspect its task and root-only journal. A partial dump/archive is not a successful backup. TOC validation is not a restore drill. Keep an off-host encrypted copy.
- **Update failed/interrupted:** inspect task journal and the bounded `hotspark-update-TASK_UUID` container log. Retain the database backup and old release. Do not rerun uncertain migrations or overwrite a staged release blindly. See [platform updates](platform-updates.md).
- **After reboot:** allow the agent to restore tmpfs secrets and reconcile. Check desired versus observed state; intentionally stopped projects should remain stopped. Uncertain migrations require operator review.
- **TLS unknown:** no readable ACME state or no certificates yet. Confirm public DNS, ports 80/443, resolver configuration and TLS-enabled routing. Default test certificates do not validate Let's Encrypt issuance.
