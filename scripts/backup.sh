#!/usr/bin/env bash
# Backup the AutoViewer platform (settings DB + WhatsApp sessions).
#
# Usage:
#   scripts/backup.sh [destination-dir]
#
# The WhatsApp session files are CREDENTIALS — the archive is written with
# owner-only permissions and should be stored somewhere encrypted/private.
#
# Restore: stop the service, unpack the archive over the app directory, then
# start it again (see docs/OPERATIONS.md).

set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="${1:-$APP_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/autoviewer-$STAMP.tar.gz"

mkdir -p "$DEST"
chmod 700 "$DEST"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Load the same configuration files as the app, without printing secrets.
SESSION_SOURCE="$(node - "$APP_DIR" <<'NODE'
const path = require('path');
const fs = require('fs');
const app = process.argv[2];
const config = path.join(app, 'config.js');
if (fs.existsSync(config)) require(config);
const source = path.resolve(app, process.env.SESSION_DIR || 'session');
console.log(fs.existsSync(source) ? fs.realpathSync(source) : source);
NODE
)"
if [ ! -d "$SESSION_SOURCE" ]; then
  echo "Session directory does not exist: $SESSION_SOURCE" >&2
  exit 1
fi
DEST_REAL="$(cd "$DEST" && pwd -P)"
case "$DEST_REAL/" in
  "$SESSION_SOURCE/"*) echo "Backup destination must be outside the session directory." >&2; exit 1 ;;
esac
# Copy the entire session tree: sender keys, pre-keys, administrator settings,
# login sessions, and future key types must survive a backup/restore too.
cp -a "$SESSION_SOURCE" "$tmp/session"
# A restored installation must acquire its own live-process lock.
rm -f "$tmp/session/autoviewer.lock"

tar -czf "$OUT" -C "$tmp" .
chmod 600 "$OUT"

echo "Backup written: $OUT"
echo "Size: $(du -h "$OUT" | cut -f1)"
echo "Restore: stop AutoViewer, extract the archive, then restore its session/ contents into '$SESSION_SOURCE'."
