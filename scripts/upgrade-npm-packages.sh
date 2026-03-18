#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Checking outdated packages..."
npm outdated || true

echo "Upgrading packages..."
npx npm-check-updates -u --reject knockout
npm install
npm audit fix

echo "Running smoke test..."
if ! npm run test:smoke; then
  cat >&2 << 'EOF'

Dependency upgrade aborted: smoke test failed.

If the browser smoke test reports:
	- Unable to parse bindings
	- Strict mode code may not include a with statement

then the regression is the known Knockout + Trusted Types + ESM runtime issue.

Recommended action:
	1. Keep knockout pinned to 3.5.1 in package.json
	2. Exclude knockout from automatic upgrades
	3. Re-run this upgrade script after restoring the pinned version

EOF
  exit 1
fi

echo "Done."
