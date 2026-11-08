#!/usr/bin/env bash
set -euo pipefail

# The persistent self-hosted VM image lacks Ubuntu's libmanette-0.2-0, so
# Playwright's WebKit MiniBrowser fails to launch with
# "Host system is missing dependencies to run browsers ... libmanette-0.2-0".
# Self-hosted runners have no passwordless sudo, so place the pinned payload
# on the browser bundle's library path instead of mutating the host with apt.

readonly MANETTE_VERSION='0.2.9-2'
readonly MANETTE_SHA256='e3b799fbb0cdbe0862c48c09ceca1115a6e9232717947f2ee0f19ea45b4b2ece'
readonly MANETTE_URL="https://archive.ubuntu.com/ubuntu/pool/main/libm/libmanette/libmanette-0.2-0_${MANETTE_VERSION}_amd64.deb"

: "${RUNNER_TEMP:?prepare-ci-webkit-manette requires RUNNER_TEMP}"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-webkit-manette supports only Linux x86_64 runners' >&2
  exit 0
fi

shopt -s nullglob
webkit_dirs=("$PLAYWRIGHT_BROWSERS_PATH"/webkit-*/minibrowser-wpe)
if (( ${#webkit_dirs[@]} == 0 )); then
  echo 'no Playwright WebKit bundle found; nothing to do' >&2
  exit 0
fi

# Already provided by the host image? Nothing to do.
if ldconfig -p 2>/dev/null | grep -q 'libmanette-0.2\.so\.0'; then
  echo 'libmanette already provided by the host image'
  exit 0
fi

archive="${RUNNER_TEMP}/libmanette-0.2-0_${MANETTE_VERSION}_amd64.deb"
root="${RUNNER_TEMP}/dsh-webkit-manette"

curl --fail --silent --show-error --location --retry 3 --retry-all-errors --output "$archive" "$MANETTE_URL"
printf '%s  %s\n' "$MANETTE_SHA256" "$archive" | sha256sum --check --status
mkdir -p "$root"
dpkg-deb --extract "$archive" "$root"

lib_dir="$root/usr/lib/x86_64-linux-gnu"
if [[ ! -f "$lib_dir/libmanette-0.2.so.0" ]]; then
  echo "expected libmanette-0.2.so.0 missing from payload" >&2
  exit 1
fi

for webkit_dir in "${webkit_dirs[@]}"; do
  sys_lib="$webkit_dir/sys/lib"
  mkdir -p "$sys_lib"
  cp "$lib_dir/libmanette-0.2.so.0" "$sys_lib/"
  echo "placed libmanette runtime in $sys_lib"
  "$webkit_dir/MiniBrowser" --help >/dev/null
  echo "WebKit MiniBrowser launch probe passed for $webkit_dir"
done
