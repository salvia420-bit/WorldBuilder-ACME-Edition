#!/usr/bin/env bash
# tools/film/install-claude.sh — link the AC Film Mode Claude Code packaging into ~/.claude.
#
# WHY
#   Film mode (`?filmMode=on`, DEFAULT OFF) is directed by a Claude Code session: the `film-mode` skill and the
#   `film-director` agent. Their canonical copies live in the repo (reviewed and versioned with the code they
#   describe); Claude Code loads user-level skills/agents from ~/.claude. Symlinks keep exactly one copy, so a
#   pull updates the installed skill and agent at once.
#
# WHAT
#   $REPO/.claude/skills/film-mode         → $HOME/.claude/skills/film-mode
#   $REPO/.claude/agents/film-director.md  → $HOME/.claude/agents/film-director.md
#   ($REPO = the WorldBuilder-ACME-Edition checkout that contains this script.)
#   - Idempotent: a link that already points at the repo is left alone; any other SYMLINK is replaced.
#   - Refuses (exit 1, nothing changed) when a destination is a real file or directory — move it away first.
#   - Creates the parent directories. Honours $HOME (tests point it at a temp dir).
#   - --uninstall removes only symlinks that point into this repo; anything else is left untouched.
#   - --dry-run prints what would happen and changes nothing.
#
# USAGE
#   tools/film/install-claude.sh              # install (or refresh) the links
#   tools/film/install-claude.sh --dry-run    # show the plan only
#   tools/film/install-claude.sh --uninstall  # remove our links
#   tools/film/install-claude.sh --uninstall --dry-run
#   Exit: 0 ok · 1 refused / a source is missing · 2 usage.

set -euo pipefail

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "install-claude: unknown argument '$arg' (use --dry-run, --uninstall or --help)" >&2
      exit 2
      ;;
  esac
done

if [ -z "${HOME:-}" ]; then
  echo "install-claude: \$HOME is not set" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# tools/film → holtburger-web → apps → holtburger → external → the repo root
REPO="$(cd "$SCRIPT_DIR/../../../../../.." && pwd -P)"

SOURCES=("$REPO/.claude/skills/film-mode" "$REPO/.claude/agents/film-director.md")
DESTS=("$HOME/.claude/skills/film-mode" "$HOME/.claude/agents/film-director.md")

# The canonical absolute target a symlink points at (relative targets resolve against the link's directory).
link_target() {
  local dest="$1" raw
  raw="$(readlink -- "$dest")"
  case "$raw" in
    /*) realpath -m -- "$raw" ;;
    *) realpath -m -- "$(dirname -- "$dest")/$raw" ;;
  esac
}

points_into_repo() {
  local target
  target="$(link_target "$1")"
  [ "$target" = "$REPO" ] || [ "${target#"$REPO"/}" != "$target" ]
}

say() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] $*"
  else
    echo "$*"
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  for i in "${!DESTS[@]}"; do
    dest="${DESTS[$i]}"
    if [ -L "$dest" ]; then
      if points_into_repo "$dest"; then
        say "remove  $dest -> $(readlink -- "$dest")"
        if [ "$DRY_RUN" = 0 ]; then rm -f -- "$dest"; fi
      else
        say "keep    $dest (a symlink to $(readlink -- "$dest"), not into $REPO)"
      fi
    elif [ -e "$dest" ]; then
      say "keep    $dest (a real file or directory, not our link)"
    else
      say "absent  $dest"
    fi
  done
  exit 0
fi

# Install: check everything first, so a refusal changes nothing.
for i in "${!SOURCES[@]}"; do
  src="${SOURCES[$i]}"
  dest="${DESTS[$i]}"
  if [ ! -e "$src" ]; then
    echo "install-claude: source missing: $src" >&2
    exit 1
  fi
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "install-claude: refusing to replace $dest — it is a real file or directory, not a symlink. Move it away (or merge it into $src) and run again." >&2
    exit 1
  fi
done

for i in "${!SOURCES[@]}"; do
  src="${SOURCES[$i]}"
  dest="${DESTS[$i]}"
  if [ -L "$dest" ]; then
    if [ "$(link_target "$dest")" = "$(realpath -m -- "$src")" ]; then
      say "ok      $dest -> $src (already linked)"
      continue
    fi
    say "relink  $dest -> $src (was -> $(readlink -- "$dest"))"
    if [ "$DRY_RUN" = 0 ]; then
      rm -f -- "$dest"
      ln -s -- "$src" "$dest"
    fi
  else
    say "link    $dest -> $src"
    if [ "$DRY_RUN" = 0 ]; then
      mkdir -p -- "$(dirname -- "$dest")"
      ln -s -- "$src" "$dest"
    fi
  fi
done
exit 0
