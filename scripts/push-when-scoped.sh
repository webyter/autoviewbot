#!/usr/bin/env bash
# Wait for the gh token refresh (workflow scope), then push branch + tags.
set -uo pipefail
cd /home/ubuntu/autoviewbot || exit 1
DEADLINE=$(( $(date +%s) + ${1:-900} ))
echo "[watcher] waiting for the refreshed token (scope: workflow)…"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if gh auth status 2>/dev/null | grep -q "'workflow'"; then
        echo "[watcher] token refreshed — pushing…"
        if GIT_TERMINAL_PROMPT=0 timeout 120 git push origin master --follow-tags; then
            echo "[watcher] PUSH OK"
            git status -sb | head -2
            exit 0
        fi
        echo "[watcher] push failed, retrying in 20s…"
    fi
    sleep 10
done
echo "[watcher] timed out"
exit 1
