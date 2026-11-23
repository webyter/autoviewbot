#!/usr/bin/env bash
# Push the workflow files once the token has the `workflow` scope.
#
# GitHub refuses to push `.github/workflows/*` with an OAuth token that lacks
# the `workflow` scope — via git push AND via the REST Git Data API (push
# protection applies to both). Everything else is already pushed; only these
# two files are left.

set -uo pipefail
cd /home/ubuntu/autoviewbot || exit 1
DEADLINE=$(( $(date +%s) + ${1:-1800} ))

echo "[wf] waiting for a token with the 'workflow' scope…"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if gh auth status 2>/dev/null | grep -q "'workflow'"; then
        echo "[wf] token has 'workflow' — pushing the workflow files…"
        if GIT_TERMINAL_PROMPT=0 timeout 120 git push origin master --follow-tags; then
            echo "[wf] PUSH OK"
            git status -sb | head -2
            git log --oneline -2
            exit 0
        fi
        echo "[wf] push failed, retrying in 20s…"
    fi
    sleep 10
done
echo "[wf] timed out"
exit 1
