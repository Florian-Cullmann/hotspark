#!/bin/sh
# A literal heredoc safely supports both files and curl | sudo sh.
exec bash -s -- "$@" <<'HOTSPARK_INSTALLER'
set -Eeuo pipefail
umask 027
trap 'printf "Hotspark installation failed at line %s. Existing data was preserved.\n" "$LINENO" >&2' ERR

log() { printf '[hotspark] %s\n' "$*"; }
die() { printf '[hotspark] %s\n' "$*" >&2; exit 1; }
validate() {
  [ "$(id -u)" -eq 0 ] || die 'Run as root.'
  # shellcheck disable=SC1091
  . "${HOTSPARK_OS_RELEASE:-/etc/os-release}"
  [ "$ID" = debian ] && [ "$VERSION_ID" = 13 ] || die 'Only Debian 13 is supported.'
  arch=$(dpkg --print-architecture)
  case "$arch" in amd64|arm64) ;; *) die "Unsupported architecture: $arch" ;; esac
  [ -d /run/systemd/system ] || die 'A booted systemd host is required.'
}
install_docker() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl tar coreutils util-linux git
  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<DOCKER
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: trixie
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER
  apt-get update
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}
prepare_paths() {
  install -d -m 0755 /opt/hotspark/releases /etc/hotspark /var/lib/hotspark /var/log/hotspark
  install -d -m 0700 /etc/hotspark/secrets /var/lib/hotspark/projects /var/lib/hotspark/database
  chown 10001:10001 /var/lib/hotspark/database
  install -d -m 0755 /var/lib/hotspark/routes
  install -d -o 10001 -g 10001 -m 0700 /var/lib/hotspark/acme
  install -d -o root -g 10001 -m 0750 /run/hotspark
  printf 'd /run/hotspark 0750 root 10001 -\n' > /etc/tmpfiles.d/hotspark.conf
  for name in database_password admin_password; do
    if [ ! -e "/etc/hotspark/secrets/$name" ]; then openssl rand -hex 32 > "/etc/hotspark/secrets/$name"; fi
    chown 10001:10001 "/etc/hotspark/secrets/$name"
    chmod 0400 "/etc/hotspark/secrets/$name"
  done
}
install_release() {
  version=${HOTSPARK_VERSION:-0.1.0}
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Version must be a numeric release version.'
  release="/opt/hotspark/releases/$version"
  if [ ! -d "$release" ]; then
    staging=$(mktemp -d /opt/hotspark/releases/.staging.XXXXXX)
    if [ -n "${HOTSPARK_SOURCE_DIR:-}" ]; then
      [ -f "$HOTSPARK_SOURCE_DIR/package-lock.json" ] || die 'Invalid local source release.'
      tar -C "$HOTSPARK_SOURCE_DIR" --exclude=node_modules --exclude=.git --exclude=.dev --exclude=dist --exclude=artifacts --exclude='*/.next' -cf - . | tar -C "$staging" -xf -
    else
      [ -n "${HOTSPARK_RELEASE_BASE_URL:-}" ] || die 'No public release host yet. Set HOTSPARK_RELEASE_BASE_URL or HOTSPARK_SOURCE_DIR.'
      [[ "$HOTSPARK_RELEASE_BASE_URL" == https://* ]] || die 'Release URL must use HTTPS.'
      archive=$(mktemp)
      curl -fsSL --proto '=https' --tlsv1.2 "$HOTSPARK_RELEASE_BASE_URL/v$version/hotspark-$version.tar.gz" -o "$archive"
      [ -n "${HOTSPARK_RELEASE_SHA256:-}" ] || die 'Set HOTSPARK_RELEASE_SHA256 from a trusted release manifest.'
      [[ "$HOTSPARK_RELEASE_SHA256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid release checksum.'
      printf '%s  %s\n' "$HOTSPARK_RELEASE_SHA256" "$archive" | sha256sum -c -
      # Release archives are trusted code after checksum verification.
      tar --no-same-owner -xzf "$archive" -C "$staging"
      rm -f "$archive"
    fi
    [ -f "$staging/deployments/compose.yaml" ] || die 'Release is missing deployment files.'
    chown -R root:root "$staging"
    mv "$staging" "$release"
  fi
  if [ ! -e /etc/hotspark/platform.env ]; then
    printf 'HOTSPARK_VERSION=%s\nADMIN_EMAIL=admin@localhost\nTLS_ENABLED=false\n' "$version" > /etc/hotspark/platform.env
  fi
  configured_version=$(sed -n 's/^HOTSPARK_VERSION=//p' /etc/hotspark/platform.env)
  [ "$configured_version" = "$version" ] || die 'Installed version differs. Use the documented update procedure.'
  if [ ! -f /etc/hotspark/traefik.yaml ]; then
    cat > /etc/hotspark/traefik.yaml <<'TRAEFIK'
entryPoints:
  web:
    address: ':8080'
  websecure:
    address: ':8443'
  health:
    address: ':8082'
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
ping:
  entryPoint: health
log:
  format: json
TRAEFIK
  fi
  chown root:10001 /etc/hotspark/traefik.yaml
  chmod 0640 /etc/hotspark/traefik.yaml
  install -m 0755 "$release/installer/platform" /usr/local/bin/platform
}
compose() { docker compose --env-file /etc/hotspark/platform.env --project-name hotspark -f "$release/deployments/compose.yaml" "$@"; }
start_platform() {
  docker network inspect hotspark-proxy >/dev/null 2>&1 || docker network create --driver bridge hotspark-proxy
  compose build --pull
  compose up -d --wait --wait-timeout 180 database
  compose run --rm --no-deps api node --input-type=module -e 'import {connectDatabase} from "./dist/packages/database/src/index.js"; import {execFileSync} from "node:child_process"; await connectDatabase(); execFileSync("./node_modules/.bin/prisma",["migrate","deploy","--schema","packages/database/prisma/schema.prisma"],{stdio:"inherit"});'
  compose up -d --wait --wait-timeout 240
  curl -fsS --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:3001/api/v1/ready >/dev/null
  curl -fsS --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:3000 >/dev/null
  ln -sfn "$release" /opt/hotspark/current
  log 'Installed. UI: http://127.0.0.1:3000 | API: http://127.0.0.1:3001/api/v1/'
  log 'Use SSH forwarding for remote administration: ssh -L 3000:127.0.0.1:3000 root@SERVER'
  log 'Admin: admin@localhost. Read the password as root: cat /etc/hotspark/secrets/admin_password'
}
main() {
  validate
  [ "${1:-}" != --validate-only ] || { log 'Host validation passed.'; return; }
  exec 9>/run/lock/hotspark-install.lock
  flock -n 9 || die 'Another install or lifecycle operation is running.'
  install_docker
  prepare_paths
  install_release
  start_platform
}
main "$@"

HOTSPARK_INSTALLER
