#!/bin/sh
# debtaur-eos local install + smoke test (macOS / Linux).
# Usage:  sh install.sh
# Needs:  Node.js 22+ on PATH. Zero npm dependencies.
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 22+ from https://nodejs.org/ then re-run."
  exit 1
fi
ver="$(node -e 'console.log(process.versions.node)')"
major="$(echo "$ver" | cut -d. -f1)"
if [ "$major" -lt 22 ]; then
  echo "Node $ver found, but this demo needs Node 22+. Update Node, then re-run."
  exit 1
fi
echo "Node $ver OK — zero dependencies to install."

echo "Smoke test: running the guided four-outcome sequence..."
out="$(printf '5\n\n\n\n\n\n8\n' | npm start 2>&1)"
case "$out" in
  *"all four outcomes as expected"*) echo "Smoke test passed: allow, refusal, escalation, integrity-refusal." ;;
  *) echo "SMOKE TEST FAILED — output was:"; echo "$out"; exit 1 ;;
esac
echo ""
echo "Run the CLI demo:      npm start"
echo "Run the browser demo:  npm run demo   then open http://localhost:8080/"
