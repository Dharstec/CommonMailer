#!/usr/bin/env bash
#
# Build the admin panel and publish it to S3 + CloudFront.
# Run this on YOUR machine (it needs the AWS CLI configured).
#
#   bash deploy/deploy-frontend.sh
#
# Reads its settings from deploy/frontend.env, which is gitignored — the bucket
# name and distribution id stay on your machine, not in the repo.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$APP_DIR/MailFrontend"
CONFIG="$APP_DIR/deploy/frontend.env"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[0;32m✓\033[0m %s\n' "$1"; }
die()  { printf '\n\033[0;31m✗ %s\033[0m\n\n' "$1"; exit 1; }

command -v aws >/dev/null 2>&1 || die "AWS CLI not found. Install it and run 'aws configure'."

if [ ! -f "$CONFIG" ]; then
    cat > "$CONFIG" <<'EOF'
# Where the admin panel is published. This file is gitignored.
S3_BUCKET=
CLOUDFRONT_DISTRIBUTION_ID=
AWS_REGION=ap-south-1
EOF
    die "Created $CONFIG — fill in your bucket and distribution id, then run this again."
fi

# shellcheck disable=SC1090
source "$CONFIG"
[ -n "${S3_BUCKET:-}" ] || die "S3_BUCKET is empty in $CONFIG"
[ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ] || die "CLOUDFRONT_DISTRIBUTION_ID is empty in $CONFIG"

# --- check the API URL is set ----------------------------------------------
PROD_ENV="$FRONTEND/src/environments/environment.prod.ts"
if grep -q "yourdomain.com\|localhost" "$PROD_ENV"; then
    die "$PROD_ENV still points at a placeholder.
  Set apiUrl to your live API, e.g. https://api.dharstec.com/api"
fi
ok "production API URL: $(grep apiUrl "$PROD_ENV" | cut -d"'" -f2)"

# --- build -----------------------------------------------------------------
say "Building"
cd "$FRONTEND"
npm ci
npx ng build --configuration production
DIST="$FRONTEND/dist/mail-frontend"
[ -d "$DIST" ] || die "Build output not found at $DIST"
ok "built to dist/"

# --- upload ----------------------------------------------------------------
say "Uploading to s3://$S3_BUCKET"

# Fingerprinted bundles (main.<hash>.js) can be cached forever — a new build
# produces a new filename, so a stale cache is impossible.
aws s3 sync "$DIST" "s3://$S3_BUCKET" \
    --region "$AWS_REGION" \
    --delete \
    --exclude "index.html" \
    --exclude "*.map" \
    --cache-control "public, max-age=31536000, immutable"

# index.html is NOT fingerprinted — it is the file that points at the new
# bundles, so it must never be cached or users keep loading the old app.
aws s3 cp "$DIST/index.html" "s3://$S3_BUCKET/index.html" \
    --region "$AWS_REGION" \
    --cache-control "no-cache, no-store, must-revalidate" \
    --content-type "text/html"
ok "uploaded"

# --- invalidate ------------------------------------------------------------
say "Invalidating CloudFront"
# Only index.html needs invalidating, for the reason above. Invalidating /* on
# every deploy is slower and past the free tier it costs money.
ID=$(aws cloudfront create-invalidation \
        --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
        --paths "/index.html" "/" \
        --query 'Invalidation.Id' --output text)
ok "invalidation $ID created"

printf '\n\033[0;32m✓ Panel deployed.\033[0m It is live once the invalidation completes (~1 min).\n\n'
