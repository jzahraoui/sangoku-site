#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Checking outdated packages..."
npm outdated || true

echo "Upgrading packages..."
npx npm-check-updates -u
npm install
npm audit fix

echo "Done."
