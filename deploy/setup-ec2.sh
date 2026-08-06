#!/usr/bin/env bash
#
# One-time setup for a fresh EC2 instance.
#
#   sudo bash deploy/setup-ec2.sh
#
# Installs Node, PostgreSQL, nginx, certbot and pm2, creates the database role,
# and writes the nginx site. Safe to run again — every step checks first.
#
# It does NOT write .env. You create that by hand afterwards (it is gitignored
# and must never be committed).

set -euo pipefail

APP_USER="${SUDO_USER:-ubuntu}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_NAME="common_mailer"
DB_USER="commonmailer"
NODE_MAJOR="20"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[0;32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[0;33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[0;31m✗ %s\033[0m\n\n' "$1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo:  sudo bash deploy/setup-ec2.sh"

# --- distro ----------------------------------------------------------------
if   command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
else die "Unsupported distro — this script handles Ubuntu/Debian and Amazon Linux 2023."
fi
say "Detected package manager: $PKG"

# --- inputs ----------------------------------------------------------------
say "Configuration"
read -rp "    API domain for this server (e.g. api.dharstec.com): " API_DOMAIN
[ -n "$API_DOMAIN" ] || die "An API domain is required — CloudFront is https, so this must be https too."

read -rp "    Email for Let's Encrypt renewal notices: " LE_EMAIL
[ -n "$LE_EMAIL" ] || die "Let's Encrypt needs an email address."

read -rsp "    Choose a database password for user '$DB_USER': " DB_PASS; echo
[ -n "$DB_PASS" ] || die "A database password is required."

# --- packages --------------------------------------------------------------
say "Installing packages"
if [ "$PKG" = apt ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg git nginx postgresql postgresql-contrib >/dev/null
    if ! command -v node >/dev/null 2>&1; then
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
        apt-get install -y -qq nodejs >/dev/null
    fi
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
else
    dnf install -y -q git nginx postgresql15 postgresql15-server certbot python3-certbot-nginx >/dev/null
    if ! command -v node >/dev/null 2>&1; then
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
        dnf install -y -q nodejs >/dev/null
    fi
    [ -d /var/lib/pgsql/data/base ] || postgresql-setup --initdb >/dev/null
fi
ok "node $(node -v), nginx, postgresql, certbot"

command -v pm2 >/dev/null 2>&1 || npm install -g pm2 --silent >/dev/null
ok "pm2 $(pm2 -v)"

# --- postgres --------------------------------------------------------------
say "PostgreSQL"
systemctl enable --now postgresql >/dev/null 2>&1 || true
sleep 2

# CREATEDB is what lets the app create its own database on first boot.
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    sudo -u postgres psql -qc "ALTER ROLE $DB_USER WITH LOGIN CREATEDB PASSWORD '$DB_PASS';"
    ok "role '$DB_USER' updated (password reset to what you just entered)"
else
    sudo -u postgres psql -qc "CREATE ROLE $DB_USER WITH LOGIN CREATEDB PASSWORD '$DB_PASS';"
    ok "role '$DB_USER' created with CREATEDB"
fi

# The app connects over TCP to localhost, so that path needs password auth
# rather than the default peer/ident.
HBA=$(sudo -u postgres psql -tAc 'SHOW hba_file;')
if ! grep -qE "^host\s+all\s+$DB_USER\s+127\.0\.0\.1/32\s+scram-sha-256" "$HBA"; then
    cp "$HBA" "$HBA.bak.$(date +%s)"
    sed -i "1i host    all    $DB_USER    127.0.0.1/32    scram-sha-256" "$HBA"
    sed -i "1i host    all    $DB_USER    ::1/128         scram-sha-256" "$HBA"
    systemctl reload postgresql
    ok "pg_hba.conf allows password login for '$DB_USER' on localhost"
else
    ok "pg_hba.conf already configured"
fi

# --- nginx -----------------------------------------------------------------
say "nginx"
APP_PORT=4100
CONF_DIR=/etc/nginx/conf.d
mkdir -p "$CONF_DIR"
sed -e "s|__API_DOMAIN__|$API_DOMAIN|g" -e "s|__APP_PORT__|$APP_PORT|g" \
    "$APP_DIR/deploy/nginx.conf.template" > "$CONF_DIR/commonmailer.conf"

# Ubuntu ships a default site that would otherwise answer first.
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "nginx config test failed — run 'nginx -t' to see why."
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl reload nginx
ok "site written to $CONF_DIR/commonmailer.conf"

# --- tls -------------------------------------------------------------------
say "HTTPS certificate"
warn "This needs $API_DOMAIN to already point at this server's public IP,"
warn "and security-group inbound rules open on ports 80 and 443."
read -rp "    Request the certificate now? [y/N] " GO_TLS
if [[ "$GO_TLS" =~ ^[Yy]$ ]]; then
    if certbot --nginx -d "$API_DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect; then
        ok "certificate installed and auto-renewal enabled"
    else
        warn "certbot failed. Fix DNS, then run:"
        warn "  sudo certbot --nginx -d $API_DOMAIN"
    fi
else
    warn "Skipped. When DNS is ready, run:  sudo certbot --nginx -d $API_DOMAIN"
fi

# --- app -------------------------------------------------------------------
say "Application"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR/MailBackend' && npm ci --omit=dev" >/dev/null
ok "backend dependencies installed"

# pm2 resurrects the process list on reboot.
sudo -u "$APP_USER" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null 2>&1 || true
env "PATH=$PATH" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null 2>&1 || true
ok "pm2 configured to start on boot"

# --- done ------------------------------------------------------------------
cat <<EOF

────────────────────────────────────────────────────────────────────────────
 Server is ready. Two steps left, both by hand:

 1. Create the .env file (it is gitignored and never committed):

      cd $APP_DIR/MailBackend
      cp .env.example .env
      nano .env

    Set exactly these three:

      POSTGRESQL_PASSWORD=$(printf '%*s' ${#DB_PASS} '' | tr ' ' '*')   ← the password you just chose
      PUBLIC_BASE_URL=https://$API_DOMAIN
      FRONTEND_ORIGIN=https://<your-cloudfront-domain>

 2. Start it:

      bash $APP_DIR/deploy/deploy-backend.sh

    On first start it creates the database, applies the schema, generates the
    encryption keys and prints the first admin password.
────────────────────────────────────────────────────────────────────────────

EOF
