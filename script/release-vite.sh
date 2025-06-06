#!/bin/bash -eu
# Script to increment version and update main branch

# Configuration
HOME_DIR="$HOME/audio/sangoku-site"
INDEX_FILE="$HOME_DIR/src/index.html"
PACKAGE_FILE="$HOME_DIR/package.json"
DEV_BRANCH="dev"
MAIN_BRANCH="main"

# Function to increment version
increment_version() {
  echo "Incrementing patch version..."
  current_version=$(grep -o 'Version [0-9.]*' "$INDEX_FILE" | cut -d' ' -f2)
  IFS='.' read -ra VERSION <<<"$current_version"
  VERSION[2]=$((VERSION[2] + 1))
  new_version="${VERSION[0]}.${VERSION[1]}.${VERSION[2]}"
  echo "New version: $new_version"
  return 0
}

# Function to update version in files and commit
update_files() {
  echo "Updating version in files..."
  sed -i "s/Version [0-9.]*/Version $new_version/" "$INDEX_FILE"
  sed -i "s/\"version\": \"[0-9.]*/\"version\": \"$new_version/" "$PACKAGE_FILE"
  git add "$INDEX_FILE" "$PACKAGE_FILE"
  git commit -m "Bump version to $new_version"
  git push
}

# Function to update main branch
update_main() {
  echo "Updating $MAIN_BRANCH branch..."
  git stash
  git checkout "$MAIN_BRANCH"
  git rebase "$DEV_BRANCH"
  git push
  git checkout "$DEV_BRANCH"
  git stash pop || true
}

# Main execution
increment_version
update_files
update_main

echo "Version updated to $new_version"
