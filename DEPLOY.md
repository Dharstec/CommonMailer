# Deployment

```
Customer static sites  ──POST──►  api.dharstec.com  (EC2: nginx → node → postgres)
                                          ▲
You ──► CloudFront ──► S3 (admin panel) ──┘
```

You set **three values** by hand. Everything else — the database, the schema,
the encryption keys, the first admin — creates itself on first boot.

---

## Part 1 — EC2 (backend)

### 1. Launch the instance

- Ubuntu 22.04 or 24.04, `t3.small` or larger (`t3.micro` is tight with Postgres)
- Security group inbound: **22** (your IP only), **80**, **443**
- Allocate an **Elastic IP** and attach it, so the address survives a reboot

### 2. Point DNS at it

Create an **A record** for `api.dharstec.com` → your Elastic IP. Do this before
the next step, or the certificate request will fail.

### 3. Clone and run setup

```bash
ssh -i your-key.pem ubuntu@<elastic-ip>

sudo apt update && sudo apt install -y git
git clone https://github.com/Dharstec/CommonMailer.git
cd CommonMailer

sudo bash deploy/setup-ec2.sh
```

It asks for three things — your API domain, an email for certificate renewal
notices, and a database password to create — then installs Node 20, PostgreSQL,
nginx, certbot and pm2, creates the database role, writes the nginx site and
requests the HTTPS certificate.

**Write the database password down.** You need it in the next step.

### 4. Create `.env`

This is the only file you write by hand. It is gitignored and never committed.

```bash
cd ~/CommonMailer/MailBackend
cp .env.example .env
nano .env
```

Set exactly these three:

```ini
POSTGRESQL_PASSWORD=the-password-from-step-3
PUBLIC_BASE_URL=https://api.dharstec.com
FRONTEND_ORIGIN=https://d111111abcdef8.cloudfront.net
```

Optionally set `SEED_ADMIN_EMAIL` to your login email.

Everything else has a default. You do **not** create `ENCRYPTION_KEY` or
`SECRET_CODE` — those are generated on first boot.

### 5. Start it

```bash
bash ~/CommonMailer/deploy/deploy-backend.sh
```

First boot does all of this on its own:

```
🔑 Generated missing secrets and saved them to .secrets.json
🗄️  Created database "common_mailer"
⏳ migration 001_init.sql ... ✅
⏳ migration 002_email_field_and_defaults.sql ... ✅
✅ First admin account created.
   Email:    gokuldsp01@gmail.com
   Password: YQ0Pk83eKpB7tPi-
🚀 CommonMailer running on port 4100
```

Check it:

```bash
curl https://api.dharstec.com/health
```

> ⚠️ **Back up `MailBackend/.secrets.json`.** It holds `ENCRYPTION_KEY`, which
> decrypts every stored SMTP password. If you lose it, each customer's SMTP
> password has to be typed in again. Keep a copy off the server.

---

## Part 2 — S3 + CloudFront (admin panel)

### 1. Bucket

Create an S3 bucket. **Block all public access — leave it on.** CloudFront
reaches the bucket through an Origin Access Control, so the bucket itself never
needs to be public.

### 2. CloudFront distribution

| Setting | Value |
|---|---|
| Origin | your S3 bucket |
| Origin access | **Origin access control**, then apply the generated bucket policy |
| Viewer protocol policy | Redirect HTTP to HTTPS |
| Default root object | `index.html` |

**Custom error responses — required.** Angular handles its own routing, so a
deep link like `/forms/2` is not a real S3 object. Without these, refreshing any
page but the root gives an S3 error:

| HTTP error code | Response page path | HTTP response code |
|---|---|---|
| 403 | `/index.html` | 200 |
| 404 | `/index.html` | 200 |

### 3. Point the panel at your API

Edit `MailFrontend/src/environments/environment.prod.ts`:

```ts
apiUrl: 'https://api.dharstec.com/api',
publicBaseUrl: 'https://api.dharstec.com'
```

Commit and push that — it is not a secret.

### 4. Deploy

On your own machine, with the AWS CLI configured:

```bash
bash deploy/deploy-frontend.sh
```

First run creates `deploy/frontend.env` and stops. Fill it in (it is gitignored)
and run again:

```ini
S3_BUCKET=dharstec-commonmailer-panel
CLOUDFRONT_DISTRIBUTION_ID=E1A2B3C4D5E6F7
AWS_REGION=ap-south-1
```

### 5. Close the loop

Put the CloudFront URL into `FRONTEND_ORIGIN` in the server's `.env`, then:

```bash
pm2 restart commonmailer
```

Without this the panel is blocked by CORS.

---

## Day-to-day

**Backend change** — push from your machine, pull on the server:

```bash
# laptop
git add . && git commit -m "..." && git push

# server
cd ~/CommonMailer && bash deploy/deploy-backend.sh
```

Schema changes apply themselves on restart — add a new numbered file in
`MailBackend/migrations/` and never edit one that has already run.

**Panel change:**

```bash
bash deploy/deploy-frontend.sh
```

**Useful commands:**

```bash
pm2 logs commonmailer          # live logs
pm2 restart commonmailer       # restart
pm2 status                     # is it up
sudo tail -f /var/log/nginx/commonmailer.error.log
```

---

## Backups

The submissions and every customer's SMTP config live in Postgres. Nightly dump:

```bash
sudo -u postgres crontab -e
```

```cron
0 2 * * * pg_dump common_mailer | gzip > /var/backups/cm-$(date +\%F).sql.gz
0 3 * * * find /var/backups -name 'cm-*.sql.gz' -mtime +30 -delete
```

A dump is only half a backup: the SMTP passwords inside it are encrypted with
`ENCRYPTION_KEY`. Store `.secrets.json` somewhere separate, or a restore leaves
you with rows you cannot decrypt.

---

## Troubleshooting

**Panel loads but every request fails** — `FRONTEND_ORIGIN` on the server does
not exactly match the CloudFront URL (scheme included), or you did not restart
after changing it.

**`Missing required values in .env`** — the message names them. `.env` must be
at `MailBackend/.env`.

**`Could not reach PostgreSQL`** — wrong `POSTGRESQL_PASSWORD`, or Postgres is
down: `sudo systemctl status postgresql`.

**`database ... may not create it`** — the role lost CREATEDB:

```bash
sudo -u postgres psql -c 'ALTER ROLE commonmailer CREATEDB;'
```

**certbot failed** — DNS is not pointing at the instance yet. Confirm with
`dig +short api.dharstec.com`, then `sudo certbot --nginx -d api.dharstec.com`.

**Refreshing `/forms/2` shows an S3 error** — the CloudFront custom error
responses in Part 2 step 2 are missing.

**Customer's form gets 403** — their website is not in that form's **Allowed
websites** (Security tab). Add www and non-www separately.
