#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p .dev
if [ ! -f .dev/database-password ]; then openssl rand -hex 24 > .dev/database-password; chmod 600 .dev/database-password; fi
export DEV_DB_PASSWORD
DEV_DB_PASSWORD=$(cat .dev/database-password)
docker compose -f deployments/dev.yaml up -d --wait
export DATABASE_URL="postgresql://hotspark:$DEV_DB_PASSWORD@127.0.0.1:55432/hotspark"
export ADMIN_PASSWORD_FILE="$PWD/.dev/admin-password"
if [ ! -f "$ADMIN_PASSWORD_FILE" ]; then openssl rand -hex 24 > "$ADMIN_PASSWORD_FILE"; chmod 600 "$ADMIN_PASSWORD_FILE"; fi
for name in SECRETS_KEY AGENT_TOKEN; do
  file="$PWD/.dev/${name,,}"
  if [ ! -f "$file" ]; then openssl rand -hex 32 > "$file"; chmod 600 "$file"; fi
  export "${name}_FILE=$file"
done
npm run generate
npm run db:migrate
npx tsx watch apps/api/src/main.ts &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT
printf 'Dev password: read .dev/admin-password. Agent operations require the full disposable-host installation.\n'
npm run dev -w @hotspark/web
