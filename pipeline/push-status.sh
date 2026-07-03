#!/usr/bin/env bash
# Publish live pipeline status to the `status` branch (read by the app's
# Data Status page via raw.githubusercontent.com — no Pages deploy needed,
# so it's instant and unaffected by deploy flakiness).
#
# Usage: push-status.sh <phase> <current-label> <queue-json> [done-label]
#   phase: discovery | menus | idle
set -e
PHASE="$1"; CURRENT="$2"; QUEUE="$3"; DONE="${4:-}"

git fetch origin status 2>/dev/null || true

PHASE="$PHASE" CURRENT="$CURRENT" QUEUE="$QUEUE" DONE="$DONE" python3 <<'EOF'
import json, os, subprocess, datetime
try:
    prev = json.loads(subprocess.run(
        ['git', 'show', 'origin/status:status.json'],
        capture_output=True, text=True).stdout or '{}')
except Exception:
    prev = {}
hist = prev.get('area_history', {})
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
if os.environ['DONE']:
    hist[os.environ['DONE']] = now
out = {
    'updated_at': now,
    'phase': os.environ['PHASE'],
    'current': os.environ['CURRENT'] or None,
    'queue': json.loads(os.environ['QUEUE'] or '[]'),
    'area_history': hist,
    'run_url': f"{os.environ.get('GITHUB_SERVER_URL','')}/{os.environ.get('GITHUB_REPOSITORY','')}/actions/runs/{os.environ.get('GITHUB_RUN_ID','')}",
}
open('/tmp/status.json', 'w').write(json.dumps(out, indent=2) + '\n')
EOF

# plumbing commit: no checkout disturbance, single-file orphan history
BLOB=$(git hash-object -w /tmp/status.json)
TREE=$(printf '100644 blob %s\tstatus.json\n' "$BLOB" | git mktree)
COMMIT=$(echo "status: $PHASE ${CURRENT:-—}" | git commit-tree "$TREE")
git push -f origin "$COMMIT:refs/heads/status"
