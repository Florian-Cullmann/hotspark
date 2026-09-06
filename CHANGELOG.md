# Changelog

Use semantic versions while treating 0.x as experimental. Each release describes public behavior changes, migration compatibility, security changes, validation and known limitations. Never silently reuse a published tag or replace a release archive.

## 0.4.0 — Unreleased

- Public-API CLI, redacted doctor/System UI, protected metrics and durable operational tasks.
- Validated PostgreSQL logical backups with checksummed recovery manifests.
- Conservative project image cleanup with dry-run and rollback retention.
- Versioned platform update runner with compatibility/checksum gates and pre-migration backup.
- Server-side logout, bounded retention and notification adapter foundation.
- Operator, automation, threat-model and restore documentation.

Still experimental: unencrypted local backups, no hostile build isolation/storage quotas, no HA or remote workers, no automatic database rollback, and no public signing/release identity.

## 0.3.0

Immutable BuildKit releases, candidate health verification, Traefik switching, maintenance, image rollback and crash recovery.
