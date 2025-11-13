#!/bin/bash
set -euo pipefail
# Script to increment version and update main branch

# Configuration
HOME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX_FILE="$HOME_DIR/src/index.html"
PACKAGE_FILE="$HOME_DIR/package.json"
DEV_BRANCH="dev"
MAIN_BRANCH="main"
NEW_VERSION=""

# Function to increment version
increment_version()
{
  echo "Incrementing patch version..."
  local current_version
  current_version=$(grep -o 'Version [0-9.]*' "$INDEX_FILE" | cut -d' ' -f2)
  local version
  IFS='.' read -ra version <<< "$current_version"
  version[2]=$((version[2] + 1))
  NEW_VERSION="${version[0]}.${version[1]}.${version[2]}"
  echo "New version: $NEW_VERSION"
  return 0
}

# Function to update version in files and commit
update_files()
{
  if [[ -z "$NEW_VERSION" ]]; then
    echo "Error: NEW_VERSION is not set."
    exit 1
  fi
  echo "Updating version in files..."
  sed -i "s/Version [0-9.]*/Version $NEW_VERSION/" "$INDEX_FILE"
  sed -i "s/\"version\": \"[0-9.]*/\"version\": \"$NEW_VERSION/" "$PACKAGE_FILE"
  git add "$INDEX_FILE" "$PACKAGE_FILE"
  git commit -m "Bump version to $NEW_VERSION"
  git push
  return 0
}

# Function to update main branch
update_main()
{
  echo "Updating $MAIN_BRANCH branch..."
  git stash
  git checkout "$MAIN_BRANCH"
  git rebase "$DEV_BRANCH"
  git push
  git checkout "$DEV_BRANCH"
  git stash pop || true
  return 0
}

# Main execution
increment_version
update_files
update_main

echo "Version updated to $NEW_VERSION"
