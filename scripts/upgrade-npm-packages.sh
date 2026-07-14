#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Checking outdated packages..."
npm outdated || true

echo "Upgrading packages..."
# --ignore-scripts (S6505) : aucun script de cycle de vie ne doit s'exécuter à
# l'installation — ni pour l'outil npx, ni pour les dépendances (aucune n'en a
# aujourd'hui) ; si une mise à jour en introduit un, le smoke test ci-dessous
# le signalera et l'installation avec scripts devra être un choix explicite.
npx --ignore-scripts npm-check-updates -u
npm install --ignore-scripts
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
