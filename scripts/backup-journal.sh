#!/usr/bin/env bash
# Back up the bridge's on-disk data — the multi-day trade journal and the basis
# cache — which are NOT in git, so a lost laptop loses them. Copies each file
# (if it exists) to ~/totoro-backups/ under a timestamped name, then prunes to
# the newest 30 of each. Quiet on success; the systemd timer runs it daily.
#
# Read-only toward the source: it only ever copies FROM server/, never writes
# back. Safe to run by hand any time.
set -euo pipefail

# Repo root = parent of this script's dir, so it works regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$HOME/totoro-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"

backup_one() {
  # $1 = source path, $2 = backup basename (without timestamp/extension)
  local src="$1" name="$2"
  [ -f "$src" ] || return 0
  cp -p "$src" "$DEST/${name}-${STAMP}.json"
  # Prune: keep the newest 30 for THIS name only. -maxdepth 1 stays in DEST.
  local old
  old="$(ls -1t "$DEST/${name}-"*.json 2>/dev/null | tail -n +31)"
  if [ -n "$old" ]; then
    printf '%s\n' "$old" | xargs -r rm -f --
  fi
}

backup_one "$REPO_DIR/server/.journal.json"    journal
backup_one "$REPO_DIR/server/.basis-cache.json" basis-cache
