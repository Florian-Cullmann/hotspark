#!/usr/bin/env bash
# Fixed privileged runner, launched by the authenticated agent from its installed image.
set -Eeuo pipefail
umask 077
version=${1:?version required}
sha=${2:?trusted checksum required}
task=${3:?task ID required}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$sha" =~ ^[a-f0-9]{64}$ && "$task" =~ ^[a-f0-9-]{36}$ ]] || exit 2
root=/var/lib/hotspark
journal="$root/operations/$task.json"
exec 9>"$root/operations/.update.lock"
flock -n 9
old=$(readlink -f /opt/hotspark/current)
old_version=$(sed -n 's/^HOTSPARK_VERSION=//p' /etc/hotspark/platform.env)
release="/opt/hotspark/releases/$version"
backup="$root/backups/update-$task"
mkdir -p "$backup"
cp /etc/hotspark/platform.env "$backup/platform.env"
phase=preparing
api_stopped=false
report() {
  node --input-type=module - "$journal" "$1" "$phase" "$version" "$backup" <<'JS'
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const [path,status,phase,version,backup] = process.argv.slice(2);
const old=JSON.parse(readFileSync(path,'utf8'));
const next={...old,status,...(status==='succeeded'?{result:{version,phase,backupId:backup.split('/').at(-1),databaseRollback:'manual restore only'}}:{error:`Update failed during ${phase}; inspect root-only update log and verified backup`})};
writeFileSync(path+'.tmp',JSON.stringify(next),{mode:0o600});renameSync(path+'.tmp',path);
JS
}
compose() { docker compose --env-file /etc/hotspark/platform.env -p hotspark -f "$release/deployments/compose.yaml" "$@"; }
recover() {
  status=$?
  if [ "$status" -ne 0 ]; then
    # Published releases must declare backward-compatible migrations. Never automatically restore a DB.
    cp "$backup/platform.env" /etc/hotspark/platform.env
    if [ "$api_stopped" = true ]; then
      docker compose --env-file /etc/hotspark/platform.env -p hotspark -f "$old/deployments/compose.yaml" up -d --wait --wait-timeout 180 api agent web proxy maintenance || true
    fi
    report failed || true
  fi
}
trap recover EXIT
[ "$old_version" != "$version" ] || { phase=already-installed; report succeeded; exit 0; }
base=$(node --input-type=module -e 'import{readFileSync}from"node:fs"; const u=new URL(JSON.parse(readFileSync("/etc/hotspark/releases.json","utf8")).baseUrl);if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash)process.exit(2);process.stdout.write(u.href.replace(/\/$/,""));')
staging=$(mktemp -d /opt/hotspark/releases/.update.XXXXXX)
phase=download
curl_tls=()
if [ -f /etc/hotspark/release-ca.pem ]; then curl_tls=(--cacert /etc/hotspark/release-ca.pem); fi
curl "${curl_tls[@]}" -fsS --proto '=https' --tlsv1.2 --max-time 120 --max-filesize 104857600 "$base/v$version/release.json" -o "$staging/manifest.json"
node --input-type=module - "$staging/manifest.json" "$version" "$sha" "$old_version" <<'JS'
import{readFileSync}from'node:fs';
const [path,version,sha,from]=process.argv.slice(2), m=JSON.parse(readFileSync(path,'utf8'));
if(m.version!==version||m.sha256!==sha||m.databaseCompatibility!=='backward-compatible'||!m.upgradeFrom?.includes(from)) throw Error('Unsupported upgrade or untrusted manifest');
JS
curl "${curl_tls[@]}" -fsS --proto '=https' --tlsv1.2 --max-time 600 --max-filesize 1073741824 "$base/v$version/hotspark-$version.tar.gz" -o "$staging/release.tar.gz"
printf '%s  %s\n' "$sha" "$staging/release.tar.gz" | sha256sum -c -
mkdir "$staging/source"
tar --no-same-owner -xzf "$staging/release.tar.gz" -C "$staging/source"
[ -f "$staging/source/deployments/compose.yaml" ]
[ ! -e "$release" ] || { echo 'Target release already exists; refusing to overwrite it.' >&2; exit 1; }
mv "$staging/source" "$release"
phase=build
# Build before stopping services. All target image tags are version-specific.
HOTSPARK_VERSION="$version" compose build --pull
phase=backup
# Pause the control-plane writer. Hosted application containers and volumes are untouched.
docker stop hotspark-api-1
api_stopped=true
docker exec hotspark-database-1 pg_dump -U hotspark -d hotspark --format=custom > "$backup/platform.dump"
test -s "$backup/platform.dump"
docker exec -i hotspark-database-1 pg_restore --list < "$backup/platform.dump" > /dev/null
sha256sum "$backup/platform.dump" > "$backup/SHA256SUMS"
phase=migrate
HOTSPARK_VERSION="$version" compose run --rm --no-deps api node --input-type=module -e 'import{connectDatabase}from"./dist/packages/database/src/index.js";import{execFileSync}from"node:child_process";await connectDatabase();execFileSync("./node_modules/.bin/prisma",["migrate","deploy","--schema","packages/database/prisma/schema.prisma"],{stdio:"inherit"});'
phase=activate
install -d -m 0700 /var/lib/hotspark/buildkit /var/lib/hotspark/operations /var/lib/hotspark/backups
sed -i "s/^HOTSPARK_VERSION=.*/HOTSPARK_VERSION=$version/" /etc/hotspark/platform.env
compose up -d --wait --wait-timeout 240 api agent web proxy maintenance
phase=healthy
ln -sfn "$release" /opt/hotspark/current
report succeeded
rm -rf "$staging"
echo "Updated platform to $version. Previous release and verified database backup retained."
