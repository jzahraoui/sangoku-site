#!/bin/bash
set -euo pipefail
# Bumps the project version, commits it on dev, and fast-forwards main.
# Pushing main triggers the GitHub workflow that deploys the site to production.

# Configuration
HOME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX_FILE="$HOME_DIR/src/index.html"
DEV_BRANCH="dev"
MAIN_BRANCH="main"
NEW_VERSION=""

cd "$HOME_DIR"

# Guards: right branch, clean tree, in sync with the remote. The version
# commit must never land on another branch, and a dirty tree must not be
# carried through the branch switches (a stash/pop dance can pop an older,
# unrelated stash and silently mix changes into the release).
check_preconditions() {
  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$current_branch" != "$DEV_BRANCH" ]]; then
    echo "Error: run from '$DEV_BRANCH' (currently on '$current_branch')." >&2
    exit 1
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Error: working tree is not clean; commit or stash first." >&2
    exit 1
  fi
  git fetch origin
  # Fails if local dev diverged from origin; a no-op when simply ahead.
  git merge --ff-only "origin/$DEV_BRANCH"
  return 0
}

# Bump the patch version. npm keeps package.json AND package-lock.json in
# sync (a raw sed on package.json leaves the lock behind); the visible
# version string in index.html is patched alongside.
increment_version() {
  echo "Incrementing patch version..."
  NEW_VERSION="$(npm version patch --no-git-tag-version)"
  NEW_VERSION="${NEW_VERSION#v}"
  sed -i "s/Version [0-9.]*/Version $NEW_VERSION/" "$INDEX_FILE"
  echo "New version: $NEW_VERSION"
  return 0
}

update_files() {
  if [[ -z "$NEW_VERSION" ]]; then
    echo "Error: NEW_VERSION is not set." >&2
    exit 1
  fi
  echo "Committing version bump on $DEV_BRANCH..."
  git add "$INDEX_FILE" "$HOME_DIR/package.json" "$HOME_DIR/package-lock.json"
  git commit -m "Bump version to $NEW_VERSION"
  git push origin "$DEV_BRANCH"
  return 0
}

# Promote dev to main, fast-forward only: main must never diverge from dev.
# If it has (a direct commit on main, a remote move), the merge fails loudly
# instead of rewriting history like the previous rebase did.
update_main() {
  echo "Updating $MAIN_BRANCH branch..."
  git checkout "$MAIN_BRANCH"
  git merge --ff-only "origin/$MAIN_BRANCH"
  git merge --ff-only "$DEV_BRANCH"
  git push origin "$MAIN_BRANCH"
  git checkout "$DEV_BRANCH"
  return 0
}

# Main execution
check_preconditions
increment_version
update_files
update_main

echo "Version updated to $NEW_VERSION"
