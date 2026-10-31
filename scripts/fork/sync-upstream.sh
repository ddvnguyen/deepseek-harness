#!/usr/bin/env bash
# Sync the dsh fork with the newest upstream release tag (fork runbook, step 1-4).
#   usage: scripts/fork/sync-upstream.sh [--tag dsh-vX.Y.Z[-pre.N]] [--base origin/integration] [--check]
#
#   --check   report only: is the fork behind, how far, will the patch series still apply.
#             Creates no branch and leaves the checkout as it found it.
#   (default) create sync/upstream-<version> from the base, merge the tag, verify the fork
#             patch series on a clean checkout of the tag, print the next steps.
#
# Exit codes: 0 up to date / merged clean, 2 merge conflict (tree left for resolution),
#             3 fork patch series no longer applies to the tag, 1 usage or environment error.
#
# What this does NOT do: push, open the PR, or regenerate patches/fork. Those need the
# install and the gates, and a person or agent reads the conflict report first.
set -euo pipefail

tag=""; base="origin/integration"; check=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
    --base) base="${2:?--base needs a value}"; shift 2 ;;
    --check) check=1; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "sync-upstream: unknown argument $1" >&2; exit 1 ;;
  esac
done

git rev-parse --git-dir >/dev/null 2>&1 || { echo "sync-upstream: not inside a git checkout" >&2; exit 1; }
git remote get-url upstream >/dev/null 2>&1 || { echo "sync-upstream: no 'upstream' remote (deepseek-ai/deepseek-harness)" >&2; exit 1; }
git fetch --quiet --tags upstream
git fetch --quiet origin

# Newest release tag. Version sort puts 0.2.2-alpha.2 below 0.2.2, as release order wants.
if [ -z "$tag" ]; then
  tag="$(git tag -l 'dsh-v[0-9]*' | sed 's/-/~/' | sort -V | sed 's/~/-/' | tail -n1)"
fi
git rev-parse --verify --quiet "refs/tags/$tag^{commit}" >/dev/null || { echo "sync-upstream: tag $tag not found" >&2; exit 1; }
version="${tag#dsh-v}"
branch="sync/upstream-$version"

if git merge-base --is-ancestor "$tag" "$base"; then
  echo "up to date: $tag is already in $base"
  exit 0
fi

behind="$(git rev-list --count "$base..$tag")"
echo "behind: $behind upstream commit(s) from $base to $tag"

# Dry merge in memory (git >= 2.38): names the conflicting files without touching the tree.
conflicts=""
if out="$(git merge-tree --write-tree --name-only --no-messages "$base" "$tag" 2>/dev/null)"; then
  echo "trial merge: clean"
else
  conflicts="$(printf '%s\n' "$out" | tail -n +2 | sed '/^$/d')"
  echo "trial merge: $(printf '%s\n' "$conflicts" | wc -l | tr -d ' ') conflicting file(s):"
  printf '  %s\n' $conflicts
fi

# Files the fork patch series owns: a conflict here needs the patch regenerated, not just resolved.
patch_files="$(git ls-tree -r --name-only "$base" patches/fork \
  | while read -r p; do git show "$base:$p" | sed -n 's/^diff --git a\/\(.*\) b\/.*/\1/p'; done | LC_ALL=C sort -u)"
if [ -n "$conflicts" ] && [ -n "$patch_files" ]; then
  owned="$(LC_ALL=C comm -12 <(printf '%s\n' "$conflicts" | LC_ALL=C sort -u) <(printf '%s\n' "$patch_files"))"
  [ -n "$owned" ] && { echo "conflicts inside the fork patch series (regenerate patches/fork):"; printf '  %s\n' $owned; }
fi

# Does the series still apply on a clean checkout of the tag? Scratch tree lives next to the checkout.
scratch="$(git rev-parse --show-toplevel)/../.sync-check-$version"
rm -rf "$scratch"
git worktree add --quiet --detach "$scratch" "$tag"
patch_ok=1
if ! ( cd "$scratch" && git checkout --quiet "$base" -- patches/fork scripts/apply-fork-patches.sh \
      && git -c user.name=sync -c user.email=sync@localhost commit --quiet -m scratch >/dev/null \
      && bash scripts/apply-fork-patches.sh . ) >"$scratch.log" 2>&1; then
  patch_ok=0
fi
git worktree remove --force "$scratch"
if [ "$patch_ok" = 1 ]; then echo "fork patch series: applies on $tag"; else echo "fork patch series: DOES NOT apply on $tag (log: $scratch.log)"; fi

if [ "$check" = 1 ]; then
  [ "$patch_ok" = 1 ] || exit 3
  [ -z "$conflicts" ] || exit 2
  exit 0
fi

git switch --quiet -c "$branch" "$base"
if ! git merge --no-ff --quiet -m "Merge upstream $tag into $branch" "$tag"; then
  echo "merge: conflicts left in the tree on $branch. Resolve, 'git add', 'git commit', then continue below." >&2
fi

cat <<EOF

next:
  1. resolve conflicts (if any) - keep the fork's seats: fork.allowWildcardHost, fork.noAuth, sidebar.sections
  2. regenerate patches/fork against $tag if a patch file conflicted or failed to apply
  3. pnpm install --frozen-lockfile ; regenerate the client slot catalog ; pnpm run test ; pnpm run build
  4. follow .agents/skills/dsh-pre-push-checks ; push $branch ; open the PR into integration
  5. after merge: dispatch moct dsh-lane-deploy.yml (lane=z, dry_run first) and post the evidence block
EOF
[ "$patch_ok" = 1 ] || exit 3
[ -z "$conflicts" ] || exit 2
