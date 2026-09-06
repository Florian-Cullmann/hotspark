#!/usr/bin/env bash
set -Eeuo pipefail
version=$(node -p "require('./package.json').version")
mkdir -p artifacts
# Run from a clean checkout; deterministic archive includes a lockfile and migration history.
tar --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner --exclude=./node_modules --exclude=./.git --exclude=./artifacts --exclude=./dist --exclude=./.dev --exclude='*/.next' --exclude='*.tsbuildinfo' -czf "artifacts/hotspark-$version.tar.gz" .
(cd artifacts && sha256sum "hotspark-$version.tar.gz" > SHA256SUMS)
cp installer/install.sh artifacts/install.sh
echo "Created artifacts/hotspark-$version.tar.gz and SHA256SUMS. Signing/publishing requires a configured release identity."
