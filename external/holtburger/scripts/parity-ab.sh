#!/usr/bin/env bash
# parity-ab.sh — answer "is this failure pre-existing?" WITHOUT touching the shared tree.
#
# WHY THIS EXISTS (2026-08-13 incident, see PARITY-LEDGER.md L2 / P1):
#   The repo at ~/WorldBuilder-ACME-Edition is ONE working tree shared by several
#   concurrent agents. `git stash`, `git stash pop`, `git checkout -- <path>` and
#   `git reset --hard` are all GLOBAL to that working tree: running one to A/B your
#   own change silently reverts every other agent's uncommitted work. Never do it.
#
#   Instead: this script builds a THROWAWAY worktree at a clean ref, runs a named
#   suite there, and deletes it. Your tree, and everyone else's edits, are untouched.
#
# USAGE
#   scripts/parity-ab.sh <suite> [ref]          # ref defaults to origin/master
#   scripts/parity-ab.sh -- <shell command>     # arbitrary command, ref = origin/master
#   scripts/parity-ab.sh --tree                 # pre-flight: whose uncommitted work is at risk?
#   scripts/parity-ab.sh --list
#   KEEP=1 scripts/parity-ab.sh js-headless     # leave the worktree for inspection
#
# SUITES
#   js-headless   harness/run-js-headless.mjs        (L4b baseline: 242P/12F/1M of 257)
#   cargo-web     cargo test -p holtburger-web --lib (L4b baseline: 230P/1F/4I)
#   cargo-dat     cargo test -p holtburger-dat       (L4b baseline: 694P/1F)
#
# Compare the number this prints against the SAME number from your dirty tree. Equal
# => pre-existing, not yours. Different => yours. Record the verdict in the ledger.
set -uo pipefail

REPO=/home/wbterminal/WorldBuilder-ACME-Edition
BASE=${PARITY_AB_BASE:-/mnt/wbterminal2/parity-ab}
WEB=apps/holtburger-web

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
[ $# -eq 0 ] && usage 1
[ "$1" = "--list" ] || [ "$1" = "-h" ] || [ "$1" = "--help" ] && usage 0

# --tree: read-only pre-flight. Who else has uncommitted work in the shared checkout?
if [ "$1" = "--tree" ]; then
  echo "shared tree: $REPO   branch: $(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  n=$(git -C "$REPO" status --porcelain | wc -l)
  if [ "$n" -eq 0 ]; then echo "clean — no uncommitted work at risk."; exit 0; fi
  echo "$n uncommitted path(s):"
  git -C "$REPO" status --porcelain | while read -r st f; do
    printf '  %-3s %-70s %s\n' "$st" "$f" "$(date -r "$REPO/$f" '+%H:%M' 2>/dev/null)"
  done
  echo
  echo "Some of these are probably NOT yours (see docs/reengineering/impl/ACTIVE-LANES.md)."
  echo "=> Do NOT run git stash / git checkout -- / git reset --hard / git clean here."
  echo "=> Commit YOUR files by explicit path; A/B with: scripts/parity-ab.sh <suite>"
  exit 1
fi

if [ "$1" = "--" ]; then shift; SUITE=custom; CUSTOM="$*"; REF=origin/master
else SUITE=$1; REF=${2:-origin/master}; CUSTOM=""; fi

command -v git >/dev/null || { echo "no git"; exit 2; }
git -C "$REPO" rev-parse --verify --quiet "$REF^{commit}" >/dev/null || {
  echo "parity-ab: ref '$REF' does not resolve in $REPO"; exit 2; }
SHA=$(git -C "$REPO" rev-parse --short "$REF")

WT="$BASE/ab-$$-$(date +%H%M%S)"
mkdir -p "$BASE"
echo "parity-ab: suite=$SUITE ref=$REF ($SHA)"
echo "parity-ab: worktree $WT  (shared tree at $REPO is NOT touched)"

# GIT_LFS_SKIP_SMUDGE: repo LFS objects 404 (fleet-runbooks.md fan-out recipe).
GIT_LFS_SKIP_SMUDGE=1 git -C "$REPO" worktree add --detach "$WT" "$REF" >/dev/null 2>&1 || {
  echo "parity-ab: worktree add failed"; exit 2; }

cleanup() {
  if [ -n "${KEEP:-}" ]; then echo "parity-ab: KEEP=1, left $WT (remove: git -C $REPO worktree remove --force $WT)"
  else git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1; fi
}
trap cleanup EXIT

# external/* is UNTRACKED in this repo (except external/holtburger, which the worktree
# already carries). Symlink the siblings in. external/chorizite is PARTIALLY tracked,
# so its CHILDREN are symlinked individually or cargo can't find protocol.xml.
mkdir -p "$WT/external"
for d in "$REPO"/external/*/; do
  n=$(basename "$d")
  [ "$n" = holtburger ] && continue
  if [ "$n" = chorizite ]; then
    mkdir -p "$WT/external/chorizite"
    for c in "$d"*; do ln -sfn "$c" "$WT/external/chorizite/$(basename "$c")"; done
  else
    ln -sfn "$d" "$WT/external/$n"
  fi
done
# node_modules / pkg are gitignored build products; borrow them read-only rather than rebuild.
for p in "$WEB/node_modules" "$WEB/pkg"; do
  s="$REPO/external/holtburger/$p"
  [ -e "$s" ] && [ ! -e "$WT/external/holtburger/$p" ] && ln -sfn "$s" "$WT/external/holtburger/$p"
done

H="$WT/external/holtburger"
CARGO="env PATH=/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin CARGO_TARGET_DIR=$BASE/target capped-build cargo"
case "$SUITE" in
  js-headless) CMD="cd $H/$WEB && node harness/run-js-headless.mjs" ;;
  cargo-web)   CMD="cd $H && $CARGO test -p holtburger-web --lib" ;;
  cargo-dat)   CMD="cd $H && $CARGO test -p holtburger-dat" ;;
  custom)      CMD="cd $H && $CUSTOM" ;;
  *) echo "parity-ab: unknown suite '$SUITE' (--list for suites)"; exit 2 ;;
esac

LOG="$BASE/last-$SUITE.log"
echo "parity-ab: \$ $CMD"
echo "---------------------------------------------------------------"
bash -c "$CMD" > "$LOG" 2>&1
RC=$?
grep -aE 'run-js-headless\]|^test result:|^error(\[|:)|panicked at' "$LOG" | tail -25
echo "---------------------------------------------------------------"
echo "parity-ab: full log -> $LOG"
echo "parity-ab: exit=$RC  suite=$SUITE  ref=$REF ($SHA)"
echo "parity-ab: compare this against the same suite run in your dirty tree."
exit "$RC"
