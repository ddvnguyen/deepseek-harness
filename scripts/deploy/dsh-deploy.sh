#!/usr/bin/env bash
# DSH deploy — Pipeline 2/3 (fork -> /mnt/workspace/clouds/dsh-<TARGET> :3181|3180). Only x is armed; z writes only with DSH_DEPLOY_ALLOW_Z=1.
#
# Runs on the self-hosted "clouds" runner as the ddv user. Never uses sudo, never
# touches TEST (3081/8110), MOCT-X (8210) or PROD (3080), and never reads or
# writes any personal DSH home. No token is read, printed or logged anywhere in
# this script.
#
# Env (all optional, defaults shown):
#   RELEASE_SHAPE per below; ReleaseRoot is the built fork checkout, HARNESS_ROOT
#   the pinned harness checkout the node_modules tree was resolved against.
#   REPO_ROOT     built fork checkout root   default: /mnt/workspace/dshx-deploy
#   HARNESS_ROOT  pinned harness checkout    default: /mnt/workspace/dsh02-cert-harness2
#   CLOUDS_ROOT   clouds root                default: /mnt/workspace/clouds
#   SERVICE       user unit to restart       default: dsh-x
#   PORT          live port                  default: 3181 (the DSH-X port)
#   KEEP_RELEASES releases to keep           default: 2
#   KEEP_BACKUPS  state snapshots to keep    default: 3
#   TRUSTED_HOST  public hostname            default: dsh-x.ddvnguyen.com
#   DRY_RUN       set to 1 to stop after the rehearsal and skip the live switch
#
# Order matches the spec's pipeline 2: package release with a two-sha manifest
# (fork sha + harness sha) -> rehearsal boot through a current symlink on a
# random free port with an isolated scratch DSH_HOME -> snapshot the live state
# if the service was running -> switch current -> restart -> smoke (trusted and
# evil Host headers, both shas) -> roll back on failure -> prune.
set -euo pipefail

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '[deploy %s] FATAL: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit "$FATAL_EXIT"; }
die_refusal() { FATAL_EXIT=3; printf '[deploy %s] FATAL: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 3; }
FATAL_EXIT=1

# TARGET picks the instance. x is the only one armed in this lane; z exists in
# the script but refuses to run unless DSH_DEPLOY_ALLOW_Z=1 is explicit (the
# prod-z gate is the human's environment + runner, so nothing arms it by
# accident).
TARGET="${TARGET:-x}"
case "$TARGET" in
  x) : ;;
  z) [ "${DSH_DEPLOY_ALLOW_Z:-0}" = "1" ] || die_refusal "TARGET=z is not armed: DSH_DEPLOY_ALLOW_Z=1 is required and nothing sets it";;
  *) die_refusal "unknown TARGET [[$TARGET]] (expected x, or z with the explicit flag)";;
esac
# REPO_ROOT is defaulted first: RELEASE_SHA falls back to the checkout HEAD,
# so under set -u it must not read REPO_ROOT before the default exists.
REPO_ROOT="${REPO_ROOT:-/mnt/workspace/dshx-deploy}"
RELEASE_SHA="${RELEASE_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
HARNESS_ROOT="${HARNESS_ROOT:-/mnt/workspace/dsh02-cert-harness2}"
HARNESS_SHA="$(git -C "$HARNESS_ROOT" rev-parse HEAD)"
# Guard against recording a wrong checkout: HARNESS_SHA_EXPECT must equal the
# pinned checkout HEAD for a real deploy. It is optional only in DRY (where
# scratch rehearsals may point anywhere); a mismatch dies with exit 4.
HARNESS_SHA_EXPECT="${HARNESS_SHA_EXPECT:-}"
[ "${DRY_RUN:-0}" = "1" ] || [ -n "$HARNESS_SHA_EXPECT" ] || { FATAL_EXIT=4; die "HARNESS_SHA_EXPECT is required for a non-DRY deploy (expected HEAD of $HARNESS_ROOT)"; }
[ -z "$HARNESS_SHA_EXPECT" ] || [ "$HARNESS_SHA" = "$HARNESS_SHA_EXPECT" ] || { FATAL_EXIT=4; die "harness checkout mismatch: $HARNESS_ROOT is $HARNESS_SHA, expected $HARNESS_SHA_EXPECT"; }
CLOUDS_ROOT="${CLOUDS_ROOT:-/mnt/workspace/clouds}"
SERVICE="${SERVICE:-dsh-$TARGET}"
case "$TARGET" in
  x) PORT="${PORT:-3181}" ;;
  z) PORT="${PORT:-3180}" ;;
esac
KEEP_RELEASES="${KEEP_RELEASES:-2}"
KEEP_BACKUPS="${KEEP_BACKUPS:-3}"
TRUSTED_HOST="${TRUSTED_HOST:-dsh-$TARGET.ddvnguyen.com}"

RELDIR="$CLOUDS_ROOT/$SERVICE/releases/$RELEASE_SHA"
CURRENT="$CLOUDS_ROOT/$SERVICE/current"
STATE_HOME="$CLOUDS_ROOT/$SERVICE/data/home"
BACKUPS="$CLOUDS_ROOT/$SERVICE/data/backups"
SCRATCH="$CLOUDS_ROOT/$SERVICE/.scratch/$RELEASE_SHA"
LOGDIR="$CLOUDS_ROOT/$SERVICE/logs"
BASE_URL="http://127.0.0.1:$PORT"
UNIT_FILE="${UNIT_FILE:-/home/ddv/.config/systemd/user/$SERVICE.service}"
PATCH_FILE="$CLOUDS_ROOT/$SERVICE/data/overlay.yml"
NODE_BIN="/home/ddv/.nvm/versions/node/v24.15.0/bin/node"
PREV_RELEASE=""
if [ -L "$CURRENT" ]; then
  RESOLVED="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  case "$RESOLVED" in "$CLOUDS_ROOT/$SERVICE/releases/"*) PREV_RELEASE="$RESOLVED";; esac
fi
HAD_PLACEHOLDER=0
[ -d "$CURRENT" ] && [ ! -L "$CURRENT" ] && HAD_PLACEHOLDER=1
TOOK_BACKUP=0
SWITCHED=0
REHEARSE_PID=""
rollback() {
  log "ROLLBACK: stopping $SERVICE"
  systemctl --user stop "$SERVICE" 2>/dev/null || true
  if [ -n "$PREV_RELEASE" ] && [ -d "$PREV_RELEASE" ]; then
    ln -sfn "releases/$(basename "$PREV_RELEASE")" "$CURRENT.new"
    mv -T "$CURRENT.new" "$CURRENT"
    log "ROLLBACK: current -> $PREV_RELEASE"
  elif [ "$SWITCHED" = "1" ]; then
    # First deploy: no previous release exists, so undo the switch instead of
    # inventing one. Drop the symlink and put the empty placeholder back.
    rm -f "$CURRENT"
    [ "$HAD_PLACEHOLDER" = "1" ] && mkdir -p "$CURRENT"
    log "ROLLBACK: no previous release; undid the switch and left current empty"
  fi
  if [ "$TOOK_BACKUP" = "1" ]; then
    LATEST="$(ls -1t "$BACKUPS"/dsh-state-*.tar.gz 2>/dev/null | head -1 || true)"
    if [ -n "$LATEST" ]; then
      rm -rf "$STATE_HOME"
      mkdir -p "$(dirname "$STATE_HOME")"
      tar -xzf "$LATEST" -C "$(dirname "$STATE_HOME")"
      log "ROLLBACK: restored state from $LATEST"
    fi
  fi
  # Bring the unit back ONLY when there is a release to serve. Restarting on a
  # first-deploy rollback starts the unit against an empty `current`, which with
  # Restart=on-failure is a crash loop: run 39010151404 reached restart counter
  # 89 on "Cannot find module .../current/dist/daemon.js" before it was stopped.
  if [ -n "$PREV_RELEASE" ] && [ -d "$PREV_RELEASE" ]; then
    systemctl --user restart "$SERVICE" 2>/dev/null || systemctl --user start "$SERVICE" 2>/dev/null || true
  else
    log "ROLLBACK: no previous release; leaving $SERVICE stopped"
  fi
  log "ROLLBACK: done"
}
cleanup() { [ -n "${REHEARSE_PID:-}" ] && kill "$REHEARSE_PID" 2>/dev/null; rm -rf "$SCRATCH"; return 0; }

# Rollback runs on EVERY failing exit path, not just the ones an ERR trap can see.
# die() calls `exit 1`, and bash never runs an ERR trap for `exit`, so an ERR-only
# trap misses every post-switch failure: the wait_health timeout after the restart,
# the /health mismatch, /schema and /team/v1/operations/head. The EXIT trap fires
# on all exit paths, so the rollback decision (and nothing else) lives here. A
# clean exit 0 skips the rollback entirely and only runs cleanup.
on_exit() {
  rc=$?
  set +e
  if [ "$rc" -ne 0 ]; then
    if [ "$SWITCHED" = "1" ]; then
      rollback
      log "deploy failed (exit $rc) and was rolled back; run marked failed"
    else
      log "deploy failed (exit $rc) before the switch; nothing live was changed"
    fi
  fi
  cleanup
}

trap on_exit EXIT
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})'
}

wait_http() { # $1 = url, $2 = wanted code (default 200 against an already-answered code), $3 = attempts (0.5s apart)
  local i code want="${2:-200}"
  for ((i = 0; i < ${3:-60}; i++)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" || true)"
    if [ "$code" != "000" ] && { [ "$want" = "000" ] || [ "$code" = "$want" ]; }; then return 0; fi
    sleep 0.5
  done
  return 1
}

host_codes() { # $1 = url -> "default=<code> trusted=<code> evil=<code>"
  printf 'default=%s trusted=%s evil=%s\n' \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true)" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $TRUSTED_HOST" "$1" || true)" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: evil.example' "$1" || true)"
}

check_host_codes() { # $1 = the host_codes line -> trusted 200, evil 403
  printf '%s\n' "$1" | node -e '
    const line = require("node:fs").readFileSync(0, "utf8");
    const map = Object.fromEntries(line.trim().split(/\s+/).map(kv => kv.split("=")));
    if (map.trusted !== "200") throw new Error("trusted host " + map.trusted + " != 200");
    if (map.evil !== "403") throw new Error("evil host " + map.evil + " != 403");
  '
}


# --- 0. preflight -----------------------------------------------------------
[ -f "$UNIT_FILE" ] || die "unit file missing: $UNIT_FILE (create it first)"
[ -f "$REPO_ROOT/apps/cli/lib/bin.js" ] || die "no built apps/cli/lib/bin.js in $REPO_ROOT — run the build step first"
[ -d "$HARNESS_ROOT/.git" ] || die "harness checkout missing: $HARNESS_ROOT"
case "$PORT" in 3080|3081|8099|8110|18081|18789|4097|8210) die "refusing to use protected port $PORT"; esac
[ "$PORT" != "3181" ] || [ "$TARGET" = "x" ] || die "port 3181 is the DSH-X port; TARGET=z uses 3180"
[ "$PORT" != "3180" ] || [ "$TARGET" = "z" ] || die "port 3180 is the DSH-Z port; TARGET=x uses 3181"
mkdir -p "$CLOUDS_ROOT/$SERVICE/releases" "$CLOUDS_ROOT/$SERVICE/data" "$STATE_HOME" "$BACKUPS" "$LOGDIR"
# The boot patch is written once from the script itself so it can never drift
# from what the smoke tests: trustedHosts stays wired to the webStartup ctx.
if [ ! -f "$PATCH_FILE" ]; then
  cat > "$PATCH_FILE" <<'YAML'
- id: web-startup
  config:
    fork:
      allowWildcardHost: true
- id: connection
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts
    fork:
      noAuth: true
YAML
  log "wrote the boot patch $PATCH_FILE"
fi
log "deploying fork sha $RELEASE_SHA with harness sha $HARNESS_SHA in the manifest"
[ "${DRY_RUN:-0}" = "1" ] && log "DRY_RUN=1 — will stop after the rehearsal, nothing live changes"

# --- 1. package the release -------------------------------------------------
if [ -f "$RELDIR/.complete" ]; then
  log "release already packaged, reusing $RELDIR"
else
  rm -rf "$RELDIR"; mkdir -p "$RELDIR"
  rsync -a \
    --exclude='/.git' --exclude='/node_modules' --exclude='/docs' --exclude='/snapshots' \
    --exclude='/website' --exclude='/benchmarks' --exclude='/python' --exclude='/.agents' \
    --exclude='/patches' --exclude='*.log' --exclude='*.tsbuildinfo' \
    "$REPO_ROOT"/ "$RELDIR"/
  # node_modules is hardlinked, never copied: the shared pnpm store and the
  # checkout's own tree already hold every file, so this is inode-cheap.
  cp -al "$REPO_ROOT/node_modules" "$RELDIR/node_modules"
  # Two-sha manifest: the fork commit being served AND the harness generation
  # the node_modules tree was resolved against. The smoke asserts both, so a
  # half-built release (right fork, stale harness) cannot pass.
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [, forkSha, harnessSha, repo, out] = process.argv;
    if (!/^[0-9a-f]{40}$/.test(forkSha)) throw new Error("invalid fork sha " + forkSha);
    if (!/^[0-9a-f]{40}$/.test(harnessSha)) throw new Error("invalid harness sha " + harnessSha);
    fs.writeFileSync(out, JSON.stringify({
      fork: { sha: forkSha, repo },
      harness: { sha: harnessSha },
      packagedAt: new Date().toISOString(),
    }, null, 2) + "\n");
  ' "$RELEASE_SHA" "$HARNESS_SHA" "ddvnguyen/moct-dsh-team-room" "$RELDIR/manifest.json" \
    || die "manifest write failed"
  grep -q "$RELEASE_SHA" "$RELDIR/manifest.json" || die "manifest missing the fork sha"
  grep -q "$HARNESS_SHA" "$RELDIR/manifest.json" || die "manifest missing the harness sha"
  : > "$RELDIR/.complete"
  log "packaged: $(du -sh "$RELDIR" | cut -f1) total, node_modules hardlinked"
fi

# --- 2. rehearsal through a current symlink, isolated scratch DSH_HOME -------
log "rehearsal boot on a random free port with a scratch DSH_HOME"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/home/profiles/web" "$SCRATCH/state"
if [ -f "$STATE_HOME/state.json" ] || [ -d "$STATE_HOME/profiles" ]; then
  cp -a "$STATE_HOME"/. "$SCRATCH/home"/ 2>/dev/null || true
fi
rm -rf "$SCRATCH/home/profiles/web/node_modules"
cp -al "$RELDIR/node_modules" "$SCRATCH/home/profiles/web/node_modules"
ln -sfn "$RELDIR" "$SCRATCH/current"
REHEARSE_PORT="$(free_port)"
(
  cd "$SCRATCH"
  export DSH_HOME="$SCRATCH/home"
  exec "$NODE_BIN" "$SCRATCH/current/apps/cli/lib/bin.js" \
    --profile web --patch "$PATCH_FILE" --host 127.0.0.1 --port "$REHEARSE_PORT" \
    --no-open --trusted-host "$TRUSTED_HOST"
) >"$LOGDIR/rehearse-$RELEASE_SHA.log" 2>&1 &
REHEARSE_PID=$!
if ! wait_http "http://127.0.0.1:$REHEARSE_PORT/" 200 90; then
  tail -n 30 "$LOGDIR/rehearse-$RELEASE_SHA.log" >&2 || true
  kill "$REHEARSE_PID" 2>/dev/null || true
  die "rehearsal boot failed to serve GET / (log above)"
fi
CODES="$(host_codes "http://127.0.0.1:$REHEARSE_PORT/")"
check_host_codes "$CODES" || { kill "$REHEARSE_PID" 2>/dev/null || true; die "rehearsal trusted-host smoke failed: $CODES"; }
log "rehearsal green on port $REHEARSE_PORT: $CODES"
kill "$REHEARSE_PID" 2>/dev/null || true; wait "$REHEARSE_PID" 2>/dev/null || true; REHEARSE_PID=""
[ "${DRY_RUN:-0}" = "1" ] && { log "DRY_RUN: rehearsal green; not switching, exiting 0"; exit 0; }

# --- 3. back up the live state before anything can change it -----------------
if systemctl --user is-active --quiet "$SERVICE"; then
  log "service is active: snapshotting $STATE_HOME first"
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  tar -czf "$BACKUPS/dsh-state-$TS.tar.gz" -C "$(dirname "$STATE_HOME")" "$(basename "$STATE_HOME")" \
    || die "pre-deploy state snapshot failed"
  TOOK_BACKUP=1
  log "snapshot written under $BACKUPS"
else
  log "service not active yet (first deploy): no live state to back up"
fi
# --- 4. switch current + restart -------------------------------------------
log "switching current -> releases/$RELEASE_SHA"
# The layout pre-creates `current` as an empty real directory, and `mv -T` of a
# symlink onto a directory fails (first live run, 2026-10-17: "cannot overwrite
# directory ... with non-directory"). rmdir only removes an EMPTY directory, so a
# `current` holding real content aborts here with a FATAL and is never deleted.
rm -f "$CURRENT.new"
if [ -d "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
  if [ -n "$(ls -A "$CURRENT" 2>/dev/null)" ]; then
    die "current is a non-empty directory; refusing to replace it: $CURRENT"
  fi
  rmdir "$CURRENT" || die "could not rmdir the empty placeholder $CURRENT"
  log "removed the empty placeholder directory at $CURRENT"
fi
ln -sfn "releases/$RELEASE_SHA" "$CURRENT.new"
mv -T "$CURRENT.new" "$CURRENT"
SWITCHED=1
log "restarting $SERVICE"
# restart falls back to start for a unit that has never been started
# (first deploy on a unit the first-deploy approval only just installed).
systemctl --user restart "$SERVICE" 2>/dev/null || systemctl --user start "$SERVICE" \
  || { journalctl --user -u "$SERVICE" -n 40 --no-pager >&2 || true; die "unit $SERVICE failed to start (journal above)"; }
for _ in 1 2 3 4 5 6; do
  systemctl --user is-active --quiet "$SERVICE" && break
  sleep 0.5
done
systemctl --user is-active --quiet "$SERVICE" \
  || { journalctl --user -u "$SERVICE" -n 40 --no-pager >&2 || true; die "unit $SERVICE is not running (journal above)"; }
if ! wait_http "$BASE_URL/" 200 90; then
  journalctl --user -u "$SERVICE" -n 40 --no-pager >&2 || true
  die "service did not serve GET / after the start (journal above; logs in $LOGDIR)"
fi
log "smoke on $BASE_URL"
"$NODE_BIN" -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (m.fork.sha !== process.argv[2]) throw new Error("manifest fork sha " + m.fork.sha + " != " + process.argv[2]);
  if (m.harness.sha !== process.argv[3]) throw new Error("manifest harness sha " + m.harness.sha + " != " + process.argv[3]);
  process.stdout.write("manifest fork sha " + m.fork.sha.slice(0, 7) + ", harness sha " + m.harness.sha.slice(0, 7) + "\n");
' "$CURRENT/manifest.json" "$RELEASE_SHA" "$HARNESS_SHA" \
  || die "smoke: manifest sha mismatch"
CODES="$(host_codes "$BASE_URL/")"
check_host_codes "$CODES" || die "smoke: trusted-host headers failed: $CODES"
log "smoke green: $CODES (fork $RELEASE_SHA / harness $HARNESS_SHA)"
# --- 6. prune ---------------------------------------------------------------
CUR_NAME="$(basename "$(readlink -f "$CURRENT")")"
ls -1t "$CLOUDS_ROOT/$SERVICE/releases" | tail -n +"$((KEEP_RELEASES + 1))" | while read -r r; do
  [ "$r" = "$CUR_NAME" ] && continue
  rm -rf "$CLOUDS_ROOT/$SERVICE/releases/$r"; log "pruned release $r"
done
# Guard the glob: with no dsh-state-*.tar.gz present (a first deploy takes no backup)
# `ls` exits 2, and pipefail would turn this harmless line into a failed run
# AFTER a green smoke, which then rolls back a healthy deploy.
if ls -1t "$BACKUPS"/dsh-state-*.tar.gz >/dev/null 2>&1; then
  ls -1t "$BACKUPS"/dsh-state-*.tar.gz | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm --
fi
log "deploy complete: $RELEASE_SHA live on $BASE_URL"
