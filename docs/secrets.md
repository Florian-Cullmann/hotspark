# Environment and secrets

`environment` contains ordinary string configuration and appears in normal project reads, plans and Compose. Never put credentials there. `secrets` in a service spec declares sensitive variable names; the creation/PATCH envelope supplies their values separately. Normal reads show declarations only. Reserved process/runtime variables and `DATABASE_URL` cannot be overridden.

```json
{
  "spec": {
    "apiVersion": "hotspark.dev/v1",
    "kind": "Application",
    "metadata": { "name": "example" },
    "services": {}
  },
  "secrets": { "web": { "PAYMENT_API_KEY": "sensitive-value" } }
}
```

This fragment illustrates the envelope; a complete request needs valid services. Omitting a secret value on PATCH preserves its existing value. Adding a declaration requires a value; removing a declaration removes it from current configuration. Secrets are available to managed Git-based Node/Next services at runtime only. Static builds cannot consume runtime secrets. Builds must not require production database credentials.

The control plane encrypts user values with AES-256-GCM, a random nonce and project-bound authenticated context. Job snapshots contain ciphertext. Idempotency fingerprints are keyed hashes so secret values cannot be guessed from an unkeyed request digest. The agent stores generated PostgreSQL credentials and user secrets in a root-only encrypted `vault.enc` using the installation's 256-bit key. Passwords are cryptographically random and stable across redeployment. `database:"database"` automatically gives an application a generated `DATABASE_URL` for that project's database.

Plaintext materialization is confined to `/run/hotspark-secrets/<UUID>/` on the host's runtime filesystem, with root-only traversal and service-owned 0400 files. Compose references file secrets; credentials are absent from Compose and Docker's configured environment. A generated loader reads the secret JSON into the application's child-process environment at startup. PostgreSQL uses its official password-file entrypoint. The agent restores runtime files from encrypted vaults at startup; redeploy forces recreation to pick up rotated application secret files. Restart policies may transiently restart containers before restored files are ready after a host reboot.

Application log reads are bounded and redact known values and PostgreSQL URLs. Redaction cannot reliably remove transformed, encoded or split values; applications must avoid logging credentials. Raw build logs and subprocess errors are not exposed through the public API. Historical encrypted deployment/job snapshots retain old values until an operator retention policy removes them.

Legacy v0.1 projects retain their original root-only password files until explicitly migrated; the encrypted vault layout applies to v2 deployments.

Local root, Docker administrators, the agent and a compromised control plane with the encryption key can read secrets. This is encryption at rest, not protection from host root. Back up the key separately and securely alongside encrypted vaults, metadata and database volumes. Losing the key loses access to encrypted secrets. Automated rekeying, database-password rotation, an external KMS and encrypted backups are not implemented.

Immutable releases retain their own authenticated encrypted vault snapshot. Plaintext release files are materialized under `/run/hotspark-secrets/releases/<release-id>/<project-id>` and recreated after reboot. Rollback uses the target release snapshot while keeping stable PostgreSQL credentials. Treat old release vaults as sensitive backups; image/log retention is not secret deletion.
