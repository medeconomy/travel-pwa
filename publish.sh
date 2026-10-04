#!/usr/bin/env bash
# Build from the vault (respecting publish.json privacy rules), commit, push.
# GitHub Actions then deploys app/ to https://medeconomy.github.io/travel-pwa/
#   ./publish.sh                        # trips listed in publish.json
#   ./publish.sh "202701_芬蘭極光"        # just this trip (still honours exclude rules)
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only -q || { echo "! git pull failed — fix that first"; exit 1; }
python3 build.py "$@"
git add -A
if git diff --cached --quiet; then echo "nothing changed"; exit 0; fi
git commit -qm "data: $(date +%Y-%m-%d\ %H:%M)"
git push
echo "✓ pushed — site updates in ~1 min: https://medeconomy.github.io/travel-pwa/"
