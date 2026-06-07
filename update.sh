#!/usr/bin/env bash
#
# update.sh — one command to refresh the live dashboard.
#
# Pulls the latest Google Sheet data, regenerates data.json/data.js, and pushes
# to GitHub so the Pages site updates. Safe to run any time; if nothing changed
# it just says so and exits without an empty commit.
#
#   ./update.sh            # refresh from the live Google Sheets
#   ./update.sh --sample   # rebuild from ./sample/*.csv instead (for testing)
#
set -euo pipefail

# Always run from the repo root, wherever this script lives.
cd "$(dirname "$0")"

# Use the project virtualenv's Python if it exists, else fall back to python3.
PY="./.venv/bin/python"
[ -x "$PY" ] || PY="python3"

echo "▶ Regenerating data ($* )..."
"$PY" ingest.py "$@"

# data.json carries a generated_at timestamp that changes every run, so a plain
# git diff always looks "changed." Compare the actual data instead, ignoring that
# timestamp, so routine refreshes with no new numbers don't create empty commits.
MEANINGFUL=$("$PY" - <<'PY'
import json, subprocess
def strip(d):
    if d is None: return None
    d = dict(d); d.pop("generated_at", None); return d
new = json.load(open("data.json"))
try:
    old = json.loads(subprocess.check_output(["git", "show", "HEAD:data.json"],
                                              stderr=subprocess.DEVNULL))
except Exception:
    old = None
print("yes" if strip(new) != strip(old) else "no")
PY
)

if [ "$MEANINGFUL" = "no" ]; then
  # Only the timestamp moved — discard it so the tree stays clean.
  git checkout -q -- data.json data.js 2>/dev/null || true
  echo "✓ No data changes — nothing to push. The live site is already current."
  exit 0
fi

git add data.json data.js
STAMP="$(date '+%Y-%m-%d %H:%M')"
git commit -q -m "Update dashboard data ($STAMP)"

echo "▶ Pushing to GitHub..."
git push -q origin HEAD

echo "✓ Pushed. GitHub Pages rebuilds in ~1 minute:"
echo "  https://jsphverro5.github.io/884-Sustainabilty-Tracker/"
