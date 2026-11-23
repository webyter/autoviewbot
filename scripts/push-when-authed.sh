#!/usr/bin/env bash
# Wait for `gh auth login` to complete, then push the branch + tags.
#
# Started automatically when a device-flow login is opened, so the user only has
# to approve the code in their browser — no extra "done" round trip.

set -uo pipefail
cd /home/ubuntu/autoviewbot || exit 1

LOG=/tmp/ghlogin.log
DEADLINE=$(( $(date +%s) + 1200 ))

echo "[watcher] waiting for GitHub auth..."
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if gh auth status >/dev/null 2>&1; then
        echo "[watcher] auth OK: $(gh auth status 2>&1 | head -1)"
        gh auth setup-git 2>/dev/null || true
        echo "[watcher] pushing master..."
        if git push origin master --follow-tags; then
            echo "[watcher] PUSH OK"
            git status -sb | head -2
            git log --oneline -3
            exit 0
        else
            echo "[watcher] push failed — trying the SSH remote"
            git remote set-url origin git@github.com:webyter/autoviewbot.git
            if git push origin master --follow-tags; then
                echo "[watcher] PUSH OK (ssh)"
                git status -sb | head -2
                exit 0
            fi
            echo "[watcher] PUSH FAILED"
            exit 1
        fi
    fi
    sleep 5
done
echo "[watcher] timed out waiting for auth"
exit 1
