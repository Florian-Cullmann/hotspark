#!/usr/bin/env bash
set -Eeuo pipefail
[ "${1:-}" = --disposable-host ] || { echo 'Requires an installed disposable host'; exit 2; }
phase=${2:-verify}
version=$(sed -n 's/^HOTSPARK_VERSION=//p' /etc/hotspark/platform.env)
docker run --rm -i --network host --user 0:0 \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src=/var/lib/hotspark/projects,dst=/var/lib/hotspark/projects \
  --mount type=bind,src=/var/lib/hotspark/backups,dst=/var/lib/hotspark/backups,readonly \
  --mount type=bind,src=/etc/hotspark/secrets/admin_password,dst=/run/secrets/admin_password,readonly \
  "hotspark/agent:$version" node --input-type=module-typescript - "$phase" < tests/operations.acceptance.ts
