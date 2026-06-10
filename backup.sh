#!/usr/bin/env bash
#
# backup.sh — commit changes, create the GitHub repo (first run), and push.
# Run from this app's folder:
#   ./backup.sh                     # public repo (build-in-public default), msg "update"
#   ./backup.sh "added the form"    # public repo, custom commit message
#   ./backup.sh --private "wip"     # private repo
#
# Repo name = this folder's name (e.g. day-02-quizmaster). Uses the gh CLI +
# your SSH key. Safe to re-run: after the repo exists it just commits + pushes.

set -euo pipefail

VIS="--public"
if [ "${1:-}" = "--private" ]; then VIS="--private"; shift; fi
if [ "${1:-}" = "--public" ]; then VIS="--public"; shift; fi

REPO="$(basename "$(pwd)")"
MSG="${1:-update}"

# Commit any pending work first.
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "$MSG"
  echo "Committed: $MSG"
else
  echo "Nothing new to commit."
fi

# First run: create the repo + push. Later runs: just push.
if git remote get-url origin >/dev/null 2>&1; then
  echo "Pushing to $(git remote get-url origin) ..."
  git push -q origin main
else
  echo "Creating GitHub repo (${VIS#--}) + pushing..."
  gh repo create "$REPO" "$VIS" --source=. --remote=origin --push
fi

echo "Backed up: $REPO"
