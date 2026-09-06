#!/usr/bin/env bash
set -Eeuo pipefail
[ "${1:-}" = --disposable-host ] || { echo 'Requires an installed disposable host'; exit 2; }
# Keep host harnesses serial; each owns the deployment worker during fixture builds.
RELEASE_FIXTURE=next bash tests/releases.integration.sh --disposable-host
bash tests/operations.acceptance.sh --disposable-host prepare
docker compose --env-file /etc/hotspark/platform.env -f /opt/hotspark/current/deployments/compose.yaml restart
bash tests/operations.acceptance.sh --disposable-host verify
# An actual VM/host reboot is an explicit operator step, followed by prepare -> reboot -> verify.
