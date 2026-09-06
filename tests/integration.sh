#!/usr/bin/env bash
set -Eeuo pipefail
name="hotspark-test-$RANDOM-$$"
password=$(openssl rand -hex 24)
cleanup() { docker rm -f "$name" >/dev/null; }
trap cleanup EXIT
docker run --name "$name" -d -e "POSTGRES_PASSWORD=$password" -e POSTGRES_USER=hotspark -e POSTGRES_DB=hotspark -p 127.0.0.1::5432 postgres:17.7-bookworm@sha256:86e0b703649d7a792bd9243ee28afc9d8f7c6b2b5638077c9d6882d4d472bbfd >/dev/null
for i in $(seq 1 60); do if docker exec "$name" pg_isready -U hotspark >/dev/null 2>&1; then break; fi; sleep 1; done
port=$(docker port "$name" 5432/tcp | cut -d: -f2)
export DATABASE_URL="postgresql://hotspark:$password@127.0.0.1:$port/hotspark"
npm run db:migrate
npx tsx tests/integration.ts
