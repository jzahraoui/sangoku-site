#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Checking outdated packages..."
npm outdated || true

echo "Upgrading packages..."
npx npm-check-updates -u
npm install
npm audit fix

echo "Running smoke test..."
if ! npm run test:smoke; then
  cat >&2 << 'EOF'

Dependency upgrade aborted: smoke test failed.
Review the test output above to identify the breaking package.

EOF
  exit 1
fi

echo "Done."
