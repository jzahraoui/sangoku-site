#!/bin/bash -eux
# .git/hooks/pre-commit

HOME_DIR="$HOME/audio/sangoku-site"
INDEX_FILE="$HOME_DIR/src/index.html"
PACKAGE_FILE="$HOME_DIR/package.json"

# Increment patch version
current_version=$(grep -o 'Version [0-9.]*' "$INDEX_FILE" | cut -d' ' -f2)
IFS='.' read -ra VERSION <<<"$current_version"
VERSION[2]=$((VERSION[2] + 1))
new_version="${VERSION[0]}.${VERSION[1]}.${VERSION[2]}"

# Update version in file
sed -i "s/Version [0-9.]*/Version $new_version/" "$INDEX_FILE"
sed -i "s/\"version\": \"[0-9.]*/\"version\": \"$new_version/" "$PACKAGE_FILE"
git add "$INDEX_FILE" "$PACKAGE_FILE"
git commit -m "Bump version to $new_version"
git push
# update main branch
git stash
git checkout main
git rebase dev
git push
# return back to dev branch
git checkout dev
git stash pop

echo "Version updated to $new_version"
