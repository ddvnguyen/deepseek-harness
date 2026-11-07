#!/usr/bin/env bash
set -euo pipefail

# The persistent self-hosted VM image lacks Ubuntu's libwoff1 package, so
# Playwright's WebKit MiniBrowser fails to launch with
# "libwoff2dec.so.1.0.2: cannot open shared object file". Self-hosted
# runners have no passwordless sudo (a terminal is required), so
# `playwright install --with-deps` cannot repair the host from CI.
# This script mirrors scripts/prepare-ci-bubblewrap.sh: download the
# pinned libwoff1 payload, verify it, and place its shared libraries on
# the MiniBrowser wrapper's library path inside PLAYWRIGHT_BROWSERS_PATH.
# No host files outside the runner workspace are mutated.

readonly WOFF_VERSION='1.0.2-3'
readonly WOFF_SHA256='115f81efcd73519bd194ab8209a8984f2a1cf89cf7b222e025b149a36a2489ab'
readonly WOFF_URL="https://archive.ubuntu.com/ubuntu/pool/universe/w/woff2/libwoff1_${WOFF_VERSION}_amd64.deb"

: "${RUNNER_TEMP:?prepare-ci-webkit-woff requires RUNNER_TEMP}"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-webkit-woff supports only Linux x86_64 runners' >&2
  exit 0
fi

shopt -s nullglob
webkit_dirs=("$PLAYWRIGHT_BROWSERS_PATH"/webkit-*/minibrowser-wpe)
if (( ${#webkit_dirs[@]} == 0 )); then
  echo 'no Playwright WebKit bundle found; nothing to do' >&2
  exit 0
fi

# Already provided by the host image? Nothing to do.
if ldconfig -p 2>/dev/null | grep -q 'libwoff2dec\.so\.1\.0\.2'; then
  echo 'libwoff2dec already provided by the host image'
  exit 0
fi

archive="${RUNNER_TEMP}/libwoff1_${WOFF_VERSION}_amd64.deb"
root="${RUNNER_TEMP}/dsh-webkit-woff"

curl --fail --silent --show-error --location --retry 3 --retry-all-errors --output "$archive" "$WOFF_URL"
printf '%s  %s\n' "$WOFF_SHA256" "$archive" | sha256sum --check --status
mkdir -p "$root"
dpkg-deb --extract "$archive" "$root"

lib_dir="$root/usr/lib/x86_64-linux-gnu"
for lib in libwoff2dec.so.1.0.2 libwoff2common.so.1.0.2; do
  if [[ ! -f "$lib_dir/$lib" ]]; then
    echo "expected $lib missing from libwoff1 payload" >&2
    exit 1
  fi
done

for webkit_dir in "${webkit_dirs[@]}"; do
  sys_lib="$webkit_dir/sys/lib"
  mkdir -p "$sys_lib"
  cp "$lib_dir/libwoff2dec.so.1.0.2" "$lib_dir/libwoff2common.so.1.0.2" "$sys_lib/"
  echo "placed libwoff2 runtime in $sys_lib"
  # The wrapper exports LD_LIBRARY_PATH with sys/lib on it; prove the
  # bundle now loads without the host package.
  "$webkit_dir/MiniBrowser" --help >/dev/null
  echo "WebKit MiniBrowser launch probe passed for $webkit_dir"
done
