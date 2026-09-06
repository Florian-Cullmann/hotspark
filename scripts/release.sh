#!/usr/bin/env bash
set -Eeuo pipefail
version=$(node -p "require('./package.json').version")
mkdir -p artifacts
# Run from a clean checkout; deterministic archive includes a lockfile and migration history.
tar --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner --exclude=./node_modules --exclude='*/node_modules' --exclude='*/.yarn/install-state.gz' --exclude=./.git --exclude=./artifacts --exclude=./dist --exclude=./.dev --exclude='*/.next' --exclude='*.tsbuildinfo' -czf "artifacts/hotspark-$version.tar.gz" .
(cd artifacts && sha256sum "hotspark-$version.tar.gz" > SHA256SUMS)
cp installer/install.sh artifacts/install.sh
(cd artifacts && sha256sum install.sh > INSTALLER_SHA256SUMS)
node --input-type=module - "$version" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const version=process.argv[2], sha256=readFileSync('artifacts/SHA256SUMS','utf8').split(/\s/)[0];
const policy=JSON.parse(readFileSync('release-policy.json','utf8'));
if(policy.version!==version||policy.databaseCompatibility!=='backward-compatible'||!Array.isArray(policy.upgradeFrom))throw Error('Review release migration policy before packaging');
writeFileSync('artifacts/release.json',JSON.stringify({...policy,sha256},null,2)+'\n');
JS
echo "Created artifacts/hotspark-$version.tar.gz and SHA256SUMS. Signing/publishing requires a configured release identity."
