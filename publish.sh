#!/usr/bin/env bash
#
# publish.sh — the "ready for the public" GitHub publish.
# Run from the app folder when the app is DONE:   ./publish.sh
#
# Order:
#   1. SECRET SCAN  — HARD GATE. Aborts if anything sensitive would be committed.
#   2. SCREENSHOT   — web apps only, best-effort -> public/screenshot.png
#   3. PUSH         — create the PUBLIC GitHub repo (first run) + push.
#
# The SMART pre-steps (write the README prose, remove unused files via knip)
# are done by Claude in-session BEFORE this — see the "Publishing" checklist
# in CLAUDE.md. This script only does the deterministic, safety-critical parts.

set -euo pipefail

REPO="$(basename "$(pwd)")"
CACHE="/tmp/npm-cache"

# ---------- 1. SECRET SCAN (hard gate) ----------
# Scans STAGED content (before any commit), so secrets can't even enter a commit.
# TWO engines run, and EITHER one trips the gate:
#   (a) native grep — covers project-specific creds that scanner rulesets miss,
#       notably Supabase's NEW sb_secret_/sb_publishable_ key format (verified
#       2026-06: betterleaks has no rule for these yet — would let them through).
#   (b) betterleaks — broad, maintained ruleset (Stripe/AWS/GitHub/etc.).
#       No --validation flag => ZERO network calls.
echo "==> Secret scan (gate)..."
git add -A   # stage exactly what would be committed (.gitignore excludes .env.local)
FAIL=0

# A tracked real .env file (not *.example) is an automatic fail.
ENV_TRACKED="$(git ls-files --cached | grep -E '(^|/)\.env($|\.)' | grep -v '\.example$' || true)"
if [ -n "$ENV_TRACKED" ]; then
  echo "  [x] real env file is tracked:"; echo "$ENV_TRACKED" | sed 's/^/      /'; FAIL=1
fi

# (a) native scan — full staged content.
# Tuned to the secrets MOST likely in this AI challenge that scanner rulesets
# miss (verified 2026-06 — gitleaks AND betterleaks both miss Supabase sb_* and
# OpenAI/Anthropic sk- keys on test values): Supabase keys + URL, OpenAI/Anthropic
# (sk-, sk-proj-, sk-ant-), Google, JWTs, AWS, Stripe, private keys.
PATTERNS='sb_secret_[A-Za-z0-9]{16,}|sb_publishable_[A-Za-z0-9]{16,}|GOCSPX-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{18,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|[a-z0-9]{20}\.supabase\.co|SERVICE_ROLE|sk-[A-Za-z0-9_-]{24,}|sk_live_[A-Za-z0-9]{16,}'
HITS="$(git grep --cached -nIE "$PATTERNS" 2>/dev/null || true)"
if [ -n "$HITS" ]; then
  echo "  [x] native scan flagged:"; echo "$HITS" | sed 's/^/      /'; FAIL=1
fi

# (b) betterleaks — broad ruleset, additive.
if command -v betterleaks >/dev/null 2>&1; then
  if ! betterleaks git . --staged --no-banner --redact >/tmp/bl-scan.out 2>&1; then
    echo "  [x] betterleaks flagged (redacted):"; tail -20 /tmp/bl-scan.out | sed 's/^/      /'; FAIL=1
  fi
else
  echo "  (note: betterleaks not installed — running native scan only)"
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "  ABORTING — sensitive content would be published. Move secrets into"
  echo "  .env.local (gitignored), read them via process.env, then re-run ./publish.sh."
  exit 1
fi
echo "  clean — nothing sensitive staged (native + betterleaks)."

# ---------- 2. SCREENSHOT (web/static apps; best-effort) ----------
PORT=""
if ls next.config.* >/dev/null 2>&1; then PORT=3000        # Next.js dev
elif ls vite.config.* >/dev/null 2>&1; then PORT=5173      # Vite dev
fi
if [ -n "$PORT" ] && [ -f package.json ]; then
  echo "==> Screenshot (booting dev server on :$PORT)..."
  npm run dev > /tmp/publish-dev.log 2>&1 &
  DEV_PID=$!
  READY=false
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:$PORT" >/dev/null 2>&1 && { READY=true; break; }
    sleep 1
  done
  if $READY; then
    mkdir -p public
    if npx --yes --cache "$CACHE" playwright@latest screenshot \
         --viewport-size=1280,800 --wait-for-timeout=3500 \
         "http://localhost:$PORT" public/screenshot.png; then
      echo "  saved public/screenshot.png"
    else
      echo "  ! screenshot failed (continuing) — see /tmp/publish-dev.log"
    fi
  else
    echo "  ! dev server didn't come up on :$PORT (continuing without screenshot)"
  fi
  kill "$DEV_PID" 2>/dev/null || true
  pkill -f "next dev" 2>/dev/null || true
  pkill -f "vite" 2>/dev/null || true
else
  echo "==> No web/static UI detected — skipping screenshot."
fi

# ---------- 3. PUSH (public repo) ----------
echo "==> Publishing to GitHub..."
git add -A
[ -n "$(git status --porcelain)" ] && git commit -q -m "Publish: ${REPO}"
if git remote get-url origin >/dev/null 2>&1; then
  git push -q origin main
  echo "  pushed -> $(git remote get-url origin)"
else
  gh repo create "$REPO" --public --source=. --remote=origin --push
fi

echo ""
echo "  Published: https://github.com/Still-InFrame/${REPO}"
echo "  Tracker:   https://www.100dayaichallenge.com/share/savion"
