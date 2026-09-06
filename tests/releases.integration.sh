#!/usr/bin/env bash
set -Eeuo pipefail
[ "${1:-}" = --disposable-host ] || { echo 'Use only on a disposable installed host: tests/releases.integration.sh --disposable-host'; exit 2; }
# Stop the regular worker while the deterministic fixture transport owns these jobs.
release=/opt/hotspark/current
compose() { docker compose --env-file /etc/hotspark/platform.env -f "$release/deployments/compose.yaml" "$@"; }
compose stop api
trap 'compose up -d api' EXIT
password=$(cat /etc/hotspark/secrets/database_password)
docker run --rm --user 0:0 --network hotspark_control --network hotspark_agent-egress \
  -e "DATABASE_URL=postgresql://hotspark:$password@database:5432/hotspark" \
  -e "TEST_PROVIDERS=${TEST_PROVIDERS:-}" \
  -e SECRETS_KEY_FILE=/run/secrets/secrets_key -e ADMIN_PASSWORD_FILE=/run/secrets/admin_password \
  --mount type=bind,src=/etc/hotspark/secrets/secrets_key,dst=/run/secrets/secrets_key,readonly \
  --mount type=bind,src=/etc/hotspark/secrets/admin_password,dst=/run/secrets/admin_password,readonly \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src=/var/lib/hotspark/projects,dst=/var/lib/hotspark/projects \
  --mount type=bind,src=/var/lib/hotspark/routes,dst=/var/lib/hotspark/routes \
  --mount type=bind,src=/run/hotspark-secrets,dst=/run/hotspark-secrets \
  --mount "type=bind,src=$PWD/tests,dst=/app/tests,readonly" \
  --mount "type=bind,src=$PWD/apps,dst=/app/apps,readonly" \
  --mount "type=bind,src=$PWD/packages,dst=/app/packages,readonly" \
  hotspark/agent:0.3.0 ./node_modules/.bin/tsx tests/releases.integration.ts
