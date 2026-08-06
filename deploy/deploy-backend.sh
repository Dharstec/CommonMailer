#!/usr/bin/env bash
#
# Deploy the backend. Run this ON the EC2 instance, as the normal user.
#
#   bash deploy/deploy-backend.sh
#
# Pulls the latest code, installs dependencies, and restarts under pm2. The
# database schema updates itself on boot, so there is no separate migrate step.
#
# This never creates or edits .env — that file is yours, lives only on this
# server, and is gitignored.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$APP_DIR/MailBackend"
APP_NAME="commonmailer"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[0;32m✓\033[0m %s\n' "$1"; }
die()  { printf '\n\033[0;31m✗ %s\033[0m\n\n' "$1"; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Do not run this with sudo. Run it as your normal user."

# --- .env must exist and be filled in --------------------------------------
if [ ! -f "$BACKEND/.env" ]; then
    die "$BACKEND/.env is missing.

  Create it by hand (it is gitignored and never committed):

    cd $BACKEND
    cp .env.example .env
    nano .env"
fi

for VAR in POSTGRESQL_PASSWORD PUBLIC_BASE_URL FRONTEND_ORIGIN; do
    VALUE=$(grep -E "^${VAR}=" "$BACKEND/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)
    [ -n "$VALUE" ] || die "$VAR is empty in $BACKEND/.env — fill it in before deploying."
done
ok ".env present with the three required values"

# --- code ------------------------------------------------------------------
say "Pulling latest code"
cd "$APP_DIR"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git pull --ff-only origin "$BRANCH"
ok "$(git log -1 --pretty='%h %s')"

# --- dependencies ----------------------------------------------------------
say "Installing dependencies"
cd "$BACKEND"
# `npm ci` is deliberate: it installs exactly the lockfile, so a deploy can
# never quietly pick up a different version than the one that was tested.
npm ci --omit=dev
ok "dependencies match package-lock.json"

mkdir -p "$BACKEND/logs"

# --- restart ---------------------------------------------------------------
say "Restarting"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    # reload keeps the old process serving until the new one is up.
    pm2 reload ecosystem.config.js --update-env
    ok "reloaded"
else
    pm2 start ecosystem.config.js
    ok "started"
fi
pm2 save >/dev/null
ok "process list saved (survives reboot)"

# --- health ----------------------------------------------------------------
say "Checking health"
PORT=$(grep -E '^PORT=' "$BACKEND/.env" | cut -d= -f2 | xargs || echo 4100)
sleep 4
for i in 1 2 3 4 5; do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
        ok "responding on port $PORT"
        break
    fi
    [ "$i" -eq 5 ] && {
        printf '\n'
        pm2 logs "$APP_NAME" --lines 40 --nostream
        die "Not responding. The log above shows why (usually .env or the database)."
    }
    sleep 3
done

# First boot prints the generated admin password to this file.
if [ -f "$BACKEND/FIRST_LOGIN.txt" ]; then
    printf '\n\033[1;33m    First admin account details are in:\033[0m\n'
    printf '      %s\n' "$BACKEND/FIRST_LOGIN.txt"
    printf '    Log in, change the password, then delete that file.\n'
fi

printf '\n\033[0;32m✓ Deployed.\033[0m  Logs:  pm2 logs %s\n\n' "$APP_NAME"
