#!/usr/bin/env bash
#
# One-time helper: push all TestFlight-pipeline secrets to GitHub via `gh`.
# Fill in the values below, then run:  bash scripts/setup-testflight.sh
#
# Prereqs: `gh auth login` done; the .p8 API key file downloaded from
# App Store Connect. See docs/CI-TESTFLIGHT.md for where each value comes from.
#
# This only writes GitHub Actions repo secrets. It does NOT touch Fly, Apple,
# or the match repo — those steps are still manual (see the doc).

set -euo pipefail

# ─── Fill these in ──────────────────────────────────────────────────────────
FLY_API_TOKEN=""                 # flyctl tokens create deploy
SUPABASE_DATABASE_URL=""         # prod pooler URL (SUPABASE_DATABASE_URL in .env.local)
IOS_API_TOKEN=""                 # apiToken in Secrets.swift (== Fly DEV_AUTH_SECRET)
APPLE_TEAM_ID=""                 # Developer portal → Membership
ASC_KEY_ID=""                    # App Store Connect API key ID
ASC_ISSUER_ID=""                 # App Store Connect API issuer ID
ASC_KEY_P8_PATH=""               # path to the downloaded AuthKey_XXXX.p8
MATCH_GIT_URL=""                 # https://github.com/simantstha/vital-certs.git
MATCH_GIT_BASIC_AUTHORIZATION="" # base64 of "user:PAT" with read access to certs repo
MATCH_PASSWORD=""                # the match encryption passphrase
# ────────────────────────────────────────────────────────────────────────────

REPO="simantstha/vital"

fail=0
for var in FLY_API_TOKEN SUPABASE_DATABASE_URL IOS_API_TOKEN APPLE_TEAM_ID \
           ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8_PATH MATCH_GIT_URL \
           MATCH_GIT_BASIC_AUTHORIZATION MATCH_PASSWORD; do
  if [ -z "${!var}" ]; then echo "✗ $var is empty"; fail=1; fi
done
[ "$fail" -eq 0 ] || { echo "Fill in the blanks above, then re-run."; exit 1; }
[ -f "$ASC_KEY_P8_PATH" ] || { echo "✗ .p8 not found at: $ASC_KEY_P8_PATH"; exit 1; }

ASC_KEY_CONTENT_BASE64="$(base64 -i "$ASC_KEY_P8_PATH" | tr -d '\n')"

set_secret() { printf '%s' "$2" | gh secret set "$1" --repo "$REPO" --body - && echo "✓ $1"; }

set_secret FLY_API_TOKEN                 "$FLY_API_TOKEN"
set_secret SUPABASE_DATABASE_URL         "$SUPABASE_DATABASE_URL"
set_secret IOS_API_TOKEN                 "$IOS_API_TOKEN"
set_secret APPLE_TEAM_ID                 "$APPLE_TEAM_ID"
set_secret ASC_KEY_ID                    "$ASC_KEY_ID"
set_secret ASC_ISSUER_ID                 "$ASC_ISSUER_ID"
set_secret ASC_KEY_CONTENT_BASE64        "$ASC_KEY_CONTENT_BASE64"
set_secret MATCH_GIT_URL                 "$MATCH_GIT_URL"
set_secret MATCH_GIT_BASIC_AUTHORIZATION "$MATCH_GIT_BASIC_AUTHORIZATION"
set_secret MATCH_PASSWORD                "$MATCH_PASSWORD"

echo ""
echo "All 10 secrets set on $REPO."
echo "Remaining manual steps (see docs/CI-TESTFLIGHT.md):"
echo "  • flyctl secrets set APPLE_BUNDLE_ID=com.simantstha.vital"
echo "  • Apple portal: enable Sign in with Apple capability on the App ID"
echo "  • App Store Connect: create the app record"
echo "  • cd ios && fastlane match appstore   (populate the certs repo once)"
echo "Then:  git tag v1.0.0 && git push origin v1.0.0"
