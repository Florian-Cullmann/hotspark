#!/usr/bin/env bash
set -Eeuo pipefail
bash -n installer/install.sh installer/platform
# Exercise both file and streamed sh launch paths against fake commands. No root operations.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '#!/bin/sh\necho 1000\n' > "$tmp/id"
chmod +x "$tmp/id"
if PATH="$tmp:$PATH" sh installer/install.sh --validate-only > "$tmp/output" 2>&1; then echo 'Installer accepted non-root execution'; exit 1; fi
rg -q 'Run as root' "$tmp/output"
if cat installer/install.sh | PATH="$tmp:$PATH" sh > "$tmp/output" 2>&1; then echo 'Piped installer accepted non-root execution'; exit 1; fi
rg -q 'Run as root' "$tmp/output"
printf '#!/bin/sh\necho 0\n' > "$tmp/id"
printf 'ID=ubuntu\nVERSION_ID=24\n' > "$tmp/os-release"
if PATH="$tmp:$PATH" HOTSPARK_OS_RELEASE="$tmp/os-release" bash installer/install.sh --validate-only > "$tmp/output" 2>&1; then echo 'Installer accepted unsupported OS'; exit 1; fi
rg -q 'Only Debian 13' "$tmp/output"
printf 'ID=debian\nVERSION_ID=13\n' > "$tmp/os-release"
printf '#!/bin/sh\necho riscv64\n' > "$tmp/dpkg"
chmod +x "$tmp/dpkg"
if PATH="$tmp:$PATH" HOTSPARK_OS_RELEASE="$tmp/os-release" bash installer/install.sh --validate-only > "$tmp/output" 2>&1; then echo 'Installer accepted unsupported architecture'; exit 1; fi
rg -q 'Unsupported architecture' "$tmp/output"
echo 'Installer validation passed (file, pipe, root, OS, architecture).'
