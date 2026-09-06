#!/usr/bin/env bash
set -Eeuo pipefail
[ "${1:-}" = --disposable-host ] || { echo 'Use only on a disposable Docker host: tests/tls.integration.sh --disposable-host'; exit 2; }
dir=$(mktemp -d)
container="hotspark-tls-test-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
chmod 0755 "$dir"
cat > "$dir/routes.yaml" <<'ROUTES'
http:
  routers:
    fixture:
      rule: Host(`tls-test.example.com`)
      entryPoints: [websecure]
      service: ping@internal
      tls: {}
ROUTES
chmod 0644 "$dir/routes.yaml"
docker run -d --name "$container" --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only \
  -p 127.0.0.1:18080:8080 -p 127.0.0.1:18443:8443 \
  --mount "type=bind,src=$dir,dst=/dynamic,readonly" \
  traefik:v3.6.6@sha256:82d3d16dde0474a51fef00b28de143d48b67f7a27453224d5e7b5aaefff26a97 \
  --entrypoints.web.address=:8080 --entrypoints.web.http.redirections.entrypoint.to=:443 \
  --entrypoints.web.http.redirections.entrypoint.scheme=https --entrypoints.websecure.address=:8443 \
  --providers.file.directory=/dynamic --providers.file.watch=true --ping=true --ping.manualrouting=true >/dev/null
for _ in $(seq 1 30); do
  if curl -kfsS --resolve tls-test.example.com:18443:127.0.0.1 https://tls-test.example.com:18443/ > "$dir/result" 2>/dev/null; then break; fi
  sleep 1
done
[ "$(cat "$dir/result")" = OK ]
curl -sS -D "$dir/headers" -o /dev/null -H 'Host: tls-test.example.com' http://127.0.0.1:18080/
rg -qi '^location: https://tls-test.example.com/' "$dir/headers" 2>/dev/null || grep -qi '^location: https://tls-test.example.com/' "$dir/headers"
echo 'TLS routing and HTTP-to-HTTPS redirect passed with a disposable default certificate; no ACME issuance claimed.'
