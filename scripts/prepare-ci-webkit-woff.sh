#!/usr/bin/env bash
set -euo pipefail

# The persistent self-hosted VM image lacks Ubuntu's libwoff1 and
# libmanette packages, so Playwright's WebKit MiniBrowser fails host
# validation ("Host system is missing dependencies ... libmanette-0.2-0")
# and then fails to launch ("libwoff2dec.so.1.0.2: cannot open shared
# object file"). Self-hosted runners have no passwordless sudo (a terminal
# is required), so `playwright install --with-deps` cannot repair the host
# from CI. This script mirrors scripts/prepare-ci-bubblewrap.sh: download
# the pinned payloads, verify them, and place their shared libraries on
# the MiniBrowser wrapper's library path inside PLAYWRIGHT_BROWSERS_PATH.
# No host files outside the runner workspace are mutated.

readonly WOFF_VERSION='1.0.2-3'
readonly WOFF_SHA256='115f81efcd73519bd194ab8209a8984f2a1cf89cf7b222e025b149a36a2489ab'
readonly WOFF_URL="https://archive.ubuntu.com/ubuntu/pool/universe/w/woff2/libwoff1_${WOFF_VERSION}_amd64.deb"
# libmanette pulls libhidapi-hidraw at load time; the host image has neither.
readonly MANETTE_VERSION='0.2.13-1'
readonly MANETTE_SHA256='2e68b011e47dd553c3142794f0f1ad86bff4924b1f4072ef2be2a447c5d69631'
readonly MANETTE_URL="https://archive.ubuntu.com/ubuntu/pool/universe/libm/libmanette/libmanette-0.2-0_${MANETTE_VERSION}_amd64.deb"
readonly HIDAPI_VERSION='0.15.0-2'
readonly HIDAPI_SHA256='839f3b4156a1c86d0353dac4f92deb4c910833dec49608635fc6a6f5eaba5e3b'
readonly HIDAPI_URL="https://archive.ubuntu.com/ubuntu/pool/universe/h/hidapi/libhidapi-hidraw0_${HIDAPI_VERSION}_amd64.deb"

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
if ldconfig -p 2>/dev/null | grep -q 'libwoff2dec\.so\.1\.0\.2' \
  && ldconfig -p 2>/dev/null | grep -q 'libmanette-0\.2\.so\.0'; then
  echo 'libwoff2dec and libmanette already provided by the host image'
  exit 0
fi

fetch_payload() {
  local url="$1" sha256="$2" archive="$3" root="$4"
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors --output "$archive" "$url"
  printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --status
  mkdir -p "$root"
  dpkg-deb --extract "$archive" "$root"
}

archive="${RUNNER_TEMP}/libwoff1_${WOFF_VERSION}_amd64.deb"
root="${RUNNER_TEMP}/dsh-webkit-woff"
fetch_payload "$WOFF_URL" "$WOFF_SHA256" "$archive" "$root"

manette_archive="${RUNNER_TEMP}/libmanette-0.2-0_${MANETTE_VERSION}_amd64.deb"
manette_root="${RUNNER_TEMP}/dsh-webkit-manette"
fetch_payload "$MANETTE_URL" "$MANETTE_SHA256" "$manette_archive" "$manette_root"

hidapi_archive="${RUNNER_TEMP}/libhidapi-hidraw0_${HIDAPI_VERSION}_amd64.deb"
hidapi_root="${RUNNER_TEMP}/dsh-webkit-hidapi"
fetch_payload "$HIDAPI_URL" "$HIDAPI_SHA256" "$hidapi_archive" "$hidapi_root"

lib_dir="$root/usr/lib/x86_64-linux-gnu"
for lib in libwoff2dec.so.1.0.2 libwoff2common.so.1.0.2; do
  if [[ ! -f "$lib_dir/$lib" ]]; then
    echo "expected $lib missing from libwoff1 payload" >&2
    exit 1
  fi
done
manette_lib="$manette_root/usr/lib/x86_64-linux-gnu/libmanette-0.2.so.0"
hidapi_lib="$hidapi_root/usr/lib/x86_64-linux-gnu/libhidapi-hidraw.so.0"
for lib in "$manette_lib" "$hidapi_lib"; do
  if [[ ! -f "$lib" ]]; then
    echo "expected $lib missing from its payload" >&2
    exit 1
  fi
done

for webkit_dir in "${webkit_dirs[@]}"; do
  sys_lib="$webkit_dir/sys/lib"
  mkdir -p "$sys_lib"
  cp "$lib_dir/libwoff2dec.so.1.0.2" "$lib_dir/libwoff2common.so.1.0.2" "$manette_lib" "$hidapi_lib" "$sys_lib/"
  # dpkg preserves the versioned soname target; keep it beside the
  # .so.0 link so the loader resolves the real file.
  cp "$hidapi_root/usr/lib/x86_64-linux-gnu/libhidapi-hidraw.so.0.15.0" "$sys_lib/" 2>/dev/null || true
  echo "placed libwoff2, libmanette and libhidapi runtime in $sys_lib"
  # The wrapper exports LD_LIBRARY_PATH with sys/lib on it; prove the
  # bundle now loads without the host packages.
  "$webkit_dir/MiniBrowser" --help >/dev/null
  echo "WebKit MiniBrowser launch probe passed for $webkit_dir"
done
