#!/usr/bin/env bash
#
# deploy.sh — deploy THIS app to Vercel and attach its subdomain.
# Run from this folder once the app works:   ./deploy.sh
#
# Subdomain auto-provisions DNS + SSL because Vercel runs 100dayaichallenge.com's DNS.
# Safe to re-run: link/domain steps no-op if they already exist.

set -euo pipefail

SLUG="rhythmrhymer"
DOMAIN="${SLUG}.100dayaichallenge.com"

# Run the Vercel CLI via npx (global installs fail on this machine; --cache dodges the
# corrupted npm cache). A function avoids zsh/bash word-splitting issues.
vercel_cli() { npx --yes --cache /tmp/npm-vercel-cache vercel@latest "$@"; }

echo "Linking + deploying to Vercel (production)..."
vercel_cli link --yes >/dev/null 2>&1 || true
vercel_cli --prod

echo "Attaching ${DOMAIN}..."
vercel_cli domains add "$DOMAIN" || true

# ---------- Sync the live URL back to GitHub ----------
# Lands the live link in the repo automatically (Website field + README) so it's
# never a manual step. Idempotent + order-independent: works whether you ran
# publish/backup BEFORE or AFTER this deploy. (Daily apps deploy via the Vercel
# CLI, not a git connection, so this push does NOT trigger a redeploy.)
LIVE_URL="https://${DOMAIN}"
echo "Syncing live URL to the repo..."

# README: insert/replace a single "**Live:**" line just under the H1 title.
if [ -f README.md ]; then
  if grep -q '^\*\*Live:\*\*' README.md; then
    sed -i '' -e "s|^\*\*Live:\*\*.*|**Live:** ${LIVE_URL}|" README.md
  else
    awk -v url="$LIVE_URL" 'NR==1{print; print ""; print "**Live:** " url; next} {print}' \
      README.md > README.md.tmp && mv README.md.tmp README.md
  fi
fi

if git remote get-url origin >/dev/null 2>&1; then
  # Set the repo's Website field (the link at the top of the GitHub repo page).
  command -v gh >/dev/null 2>&1 && gh repo edit --homepage "$LIVE_URL" >/dev/null 2>&1 || true
  # Push the README change, if there is one.
  if [ -n "$(git status --porcelain README.md 2>/dev/null)" ]; then
    git add README.md
    git commit -q -m "docs: add live URL (${LIVE_URL})"
    git push -q origin main 2>/dev/null || true
  fi
  SYNCED="GitHub repo Website field set + README updated and pushed."
else
  SYNCED="README updated locally (no GitHub repo yet) — run ./publish.sh or ./backup.sh to push it."
fi

cat <<EOF

  Deployed.
  Live at:  https://${DOMAIN}   (DNS + SSL settle in ~1 min)
  Also at:  the *.vercel.app URL printed above.
  GitHub:   ${SYNCED}

  Google-auth apps work automatically: the sandbox's *.100dayaichallenge.com
  wildcard already covers https://${DOMAIN}. Sign in via THIS subdomain
  (not the raw *.vercel.app URL).
  Log the app at https://100dayaichallenge.com

EOF
