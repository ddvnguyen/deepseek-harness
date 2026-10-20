#!/usr/bin/env bash
# Apply the dsh#02 fork patch series (patches/fork/*.patch) onto a checked-out
# upstream tag. Fails loudly on any conflict and leaves the tree for inspection.
#   usage: scripts/apply-fork-patches.sh [repo-dir]    (default: current dir)
#
# Each mailbox carries a synthetic id ("From dsh-fork-000N ...") instead of the
# commit it was generated from: a raw commit reference is a maintained
# reference the repository-references gate rejects, and `git am` does not need
# it. Regenerating the series with `git format-patch` restores the sha, so
# rewrite that first line again before committing the patch.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
series="$here/../patches/fork"
repo="${1:-$PWD}"
cd "$repo"
git diff --quiet && git diff --cached --quiet || { echo "apply-fork-patches: working tree not clean in $repo" >&2; exit 1; }
patches=("$series"/*.patch)
[ -e "${patches[0]}" ] || { echo "apply-fork-patches: no patches in $series" >&2; exit 1; }
for p in "${patches[@]}"; do
  if ! git am --3way --quiet "$p"; then
    echo "apply-fork-patches: CONFLICT applying $(basename "$p"); resolve then 'git am --continue', or 'git am --abort'" >&2
    exit 1
  fi
  echo "applied $(basename "$p")"
done
echo "apply-fork-patches: ${#patches[@]} patch(es) applied on $(git describe --tags --always)"
echo "deploy flags (opt-in, TEST only; PROD must set neither):"
echo "  webserver row:   fork.allowWildcardHost: true   (needed for --host 0.0.0.0)"
echo "  connection row:  fork.noAuth: true              (no launch token; trustedHosts stays the gate)"
echo "  keep every --trusted-host the deploy needs; an untrusted Host is still rejected."
