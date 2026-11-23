#!/usr/bin/env bash
# Keep retrying the push until GitHub's push-protection bypass allows it.
#
# Push protection (mandatory on public repos) blocks the intentionally-public
# Groq key baked into config.js. The owner approves it once via the "unblock
# secret" page; this loop then pushes automatically.

set -uo pipefail
cd /home/ubuntu/autoviewbot || exit 1

DEADLINE=$(( $(date +%s) + ${1:-900} ))
attempt=0

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    attempt=$((attempt + 1))
    out="$(GIT_TERMINAL_PROMPT=0 timeout 90 git push origin master --follow-tags 2>&1)"
    if [ $? -eq 0 ]; then
        echo "[push] SUCCESS on attempt $attempt"
        git status -sb | head -2
        git log --oneline -3
        exit 0
    fi
    # Only the secret rule can block us; anything else should surface.
    if ! printf '%s' "$out" | grep -q "GITHUB PUSH PROTECTION"; then
        echo "[push] failed for a non-secret reason:"
        printf '%s\n' "$out" | tail -12
        exit 1
    fi
    echo "[push] attempt $attempt blocked by push protection (waiting for the bypass)…"
    sleep 15
done
echo "[push] timed out"
exit 1
