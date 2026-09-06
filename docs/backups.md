# Backups and restore drills

`POST /api/v1/system/backups` queues an administrator-only persistent task. `{}` backs up the control-plane PostgreSQL database, `/etc/hotspark` (including recovery keys), project runtime metadata, routes and ACME state. `{ "projectId": "UUID" }` backs up that project's running PostgreSQL databases and agent-owned deployment metadata. Poll `/api/v1/system/tasks/:id`. A queued request is not a successful backup.

Artifacts live under `/var/lib/hotspark/backups/<taskId>/`, inside root-only directories. A successful manifest records creation time, artifact sizes, SHA-256 digests, dump/table-of-contents validation and archive validation. Failed commands produce a failed journal and never a successful manifest. Partial artifacts remain available for investigation. Replays use the same task journal. An interrupted dump is classified failed rather than automatically overwriting a possibly still-running Docker exec output; submit a new task after reviewing partial artifacts. No backup or retention command deletes application data.

The volume adapter implemented today is `postgres-logical`: each database uses its own version's `pg_dump --format=custom` and `pg_restore --list`. Arbitrary volume snapshots are not implemented. Source/build caches and application images are excluded. Retain or export immutable images separately if disaster recovery must work without source rebuilds. See [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).

## Security and consistency

Backups are **not encrypted** by this implementation. They include sensitive database contents; platform configuration archives also include encryption keys. Protect, encrypt and copy artifacts to independent storage using a reviewed tool and separately held recovery key. Local disk backups do not protect against server loss. Metadata archives and multiple databases are not one globally consistent snapshot. Avoid concurrent deployments while creating a platform backup. Per-project backup and deployment execution share the agent's project lock.

TOC and checksums validate command completion and file integrity; they do not prove successful restoration. There is no automatic database rollback. No backup download endpoint exposes these files through the public API.

## Restore on an isolated host

1. Record the platform version and exact application image IDs. Preserve `/etc/hotspark/secrets/secrets_key` independently. Verify every manifest hash before extraction.
2. Install the same supported platform version on an isolated host. Stop the API/worker and hosted applications before restoring metadata. Never overlay a live PostgreSQL data directory with a logical dump.
3. For a project, provision an empty database using the same PostgreSQL major version and generated owner identity. Copy the dump to its container and run `pg_restore --exit-on-error --no-owner --no-acl --username OWNER --dbname DATABASE /tmp/project.dump`. Restore into an empty database; do not add `--clean` casually.
4. For the control plane, restore `platform.dump` into a new empty `hotspark` database with `pg_restore --exit-on-error --no-owner --no-acl -U hotspark -d hotspark`. Restore trusted configuration/runtime archives with original ownership and restrictive permissions. Restore encrypted vaults and their matching key together.
5. Restore/exported images or deliberately rebuild from recorded revisions. Restore the project's logical databases; other volume types require their own application-specific procedure.
6. Start the agent, then API and proxy. Check desired versus observed state, maintenance, credentials, HTTP routes and real SQL/application queries. Intentionally stopped projects must remain stopped. Only then expose public DNS/traffic.

Keep original backups untouched until a complete restore drill succeeds. Database restoration and cross-version migration require operator review; this phase intentionally has no destructive restore API.
