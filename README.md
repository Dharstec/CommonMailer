# CommonMailer

One mail service for all your static-site customers.

**Admin panel** = you define which fields each form accepts.
**One API** = the customer's website POSTs the data, you get an email.
**Campaigns** = one designed email, sent to a whole list from a customer's own mailbox.

No backend code and no new deploy when a customer is added.

```
MailBackend/    Express + PostgreSQL + Nodemailer   (the API)
MailFrontend/   Angular 16 + Tailwind               (the admin panel)
```

---

## The flow

```
10 customers, all static websites

Customer 1  →  1 form   (Contact)
Customer 2  →  2 forms  (Contact + Request Information)
Customer 3  →  ...
```

Every form always has an **`email`** field. It cannot be removed, renamed or made
optional — the panel greys it out and the API rejects a save that drops it.

Everything else is whatever you add for that customer.

So each form has its own request body:

```jsonc
// POST /api/form/dharstec-contact
{ "email": "info@gmail.com", "name": "Gokul", "purpose": "test" }

// POST /api/form/dharstec-info        ← same customer, different form
{ "email": "info@gmail.com", "name": "Gokul", "sdfs": "test", "fsfsdf": "sdfsdf", "asfsdf": "sfsfsd" }
```

One endpoint, one URL per form. The backend checks the body against what you
defined for **that** form key, then sends the email.

---

## Setup

### Backend

```bash
cd MailBackend
npm install
cp .env.example .env
```

Generate the two secrets into `.env`:

```bash
# ENCRYPTION_KEY — encrypts customer SMTP passwords (must be 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# SECRET_CODE — signs admin panel logins
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
createdb -U postgres common_mailer
npm start
```

Migrations run at boot. The first admin is created from `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD` — **change that password after logging in.**

> ⚠️ `ENCRYPTION_KEY` cannot be rotated in place. If it changes, every stored
> SMTP password must be re-entered. Back it up separately from the database.

### Admin panel

```bash
cd MailFrontend
npm install
npm start          # http://localhost:4200
```

Set your real backend URL in `src/environments/environment.prod.ts` before
building for production.

---

## Adding a customer (5 minutes, no code)

**1. Customers → Add customer.** Name and website.

**2. Same page → SMTP.** Their own mailbox. Presets fill in host and port for
Gmail, Zoho, Office 365, Hostinger and GoDaddy. Save → **Test connection** →
**Send test email**.

Use *their* mailbox, not yours: mail from `info@theirsite.com` passes SPF/DKIM and
reaches the inbox instead of spam.

**3. Forms → New form.** Pick the customer. `email` is already there and locked.
Add the other fields this customer needs.

**4. Security tab → Allowed websites.** Add their site:

```
https://dharstec.com
https://www.dharstec.com
```

Only these can POST. Everyone else gets a 403. Add www and non-www separately.

**5. API tab.** Copy the endpoint, the request body and the ready-made HTML.
Paste the HTML into their static site and restyle it. Done.

Need a second form for the same customer? Just create another form — different
fields, different URL, same customer and same SMTP.

---

## What you paste into the customer's site

The **API tab** generates this for you, matching that form's exact fields:

```html
<form id="cm-form">
  <label>Email</label>
  <input type="email" name="email" required>

  <label>Name</label>
  <input type="text" name="name" required>

  <label>Purpose</label>
  <textarea name="purpose" required></textarea>

  <!-- bot traps: leave both of these exactly as they are -->
  <input type="text" name="website_url_hp" tabindex="-1" autocomplete="off"
         style="position:absolute;left:-9999px" aria-hidden="true">
  <input type="hidden" name="_ts" id="cm-ts">

  <button type="submit">Send</button>
  <p id="cm-msg"></p>
</form>

<script>
document.getElementById('cm-ts').value = Date.now();

document.getElementById('cm-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());

  const res = await fetch('https://mail.dharstec.com/api/form/dharstec-contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const out = await res.json();

  document.getElementById('cm-msg').textContent = out.message;
  if (out.status === 'success') e.target.reset();
});
</script>
```

Style it however you like — the backend only cares about the JSON keys.

---

## The API

### Submit — the only public endpoint

```http
POST /api/form/:formKey
Content-Type: application/json
```

**Success — `200`**

```json
{ "status": "success", "message": "Thank you. Your message has been sent." }
```

**Bad data — `400`** (show `errors[]` next to the matching input)

```json
{
  "status": "error",
  "message": "Please correct the highlighted fields.",
  "errors": [{ "field": "email", "message": "Email must be a valid email address" }]
}
```

| Code | Meaning |
|---|---|
| `400` | Validation failed — read `errors[]` |
| `403` | That website is not in **Allowed websites** |
| `404` | Form key does not exist, or the form/customer is switched off |
| `429` | Rate limit hit |

### Creating forms over the API instead of the panel

Everything in the panel is also an endpoint. Log in for a token:

```http
POST /api/auth/login
{ "email": "you@example.com", "password": "..." }
```

Then create the customer and the form:

```http
POST /api/tenants
{ "name": "Dharstec Solutions", "slug": "dharstec-solutions", "website_url": "https://dharstec.com" }

PUT /api/tenants/1/smtp
{ "host": "smtp.gmail.com", "port": 587, "secure": false,
  "username": "info@dharstec.com", "password": "app-password",
  "from_name": "Dharstec Solutions", "from_email": "info@dharstec.com" }

POST /api/forms
{
  "tenant_id": 1,
  "form_key": "dharstec-contact",
  "name": "Contact Form",
  "recipients": ["info@dharstec.com"],
  "allowed_origins": ["https://dharstec.com"],
  "fields": [
    { "field_key": "email",   "label": "Email",   "field_type": "email",    "is_required": true },
    { "field_key": "name",    "label": "Name",    "field_type": "text",     "is_required": true },
    { "field_key": "purpose", "label": "Purpose", "field_type": "textarea", "is_required": true }
  ]
}
```

The response carries the URL to POST to:

```json
{ "status": "success",
  "data": { "id": 1, "form_key": "dharstec-contact",
            "links": { "submit_url": "https://mail.dharstec.com/api/form/dharstec-contact" } } }
```

`PUT /api/forms/:id` updates — send the **complete** body, the field list is
replaced wholesale. The URL never changes as long as `form_key` stays the same,
so the customer's website needs no edit.

Full admin endpoint list:

```
POST   /api/auth/login | logout | change-password
GET    /api/tenants                    POST /api/tenants
GET    /api/tenants/:id                PUT  /api/tenants/:id      DELETE /api/tenants/:id
PUT    /api/tenants/:id/smtp           POST /api/tenants/:id/smtp/test | /send-test
GET    /api/forms                      POST /api/forms
GET    /api/forms/:id                  PUT  /api/forms/:id        DELETE /api/forms/:id
POST   /api/forms/:id/duplicate
GET    /api/forms/:formId/templates    PUT  /api/forms/:formId/templates
POST   /api/forms/:formId/templates/preview | /send-test
GET    /api/submissions | /stats | /export | /:id
POST   /api/submissions/:id/resend     DELETE /api/submissions/:id
GET    /api/campaigns                  POST /api/campaigns
GET    /api/campaigns/:id              PUT  /api/campaigns/:id    DELETE /api/campaigns/:id
POST   /api/campaigns/:id/duplicate | /preview | /test | /start | /pause | /cancel | /retry-failed
GET    /api/campaigns/:id/recipients | /recipients/export
POST   /api/campaigns/:id/recipients   (raw CSV body)     DELETE /api/campaigns/:id/recipients
POST   /api/campaigns/:id/attachments  (raw file body)    DELETE /api/campaigns/:id/attachments/:attachmentId
GET    /api/campaigns/unsubscribes?tenant_id=   POST /api/campaigns/unsubscribes
DELETE /api/campaigns/unsubscribes/:id
```

Opened from inside a recipient's mail client, no login (the random token is the key):

```
GET|POST /api/c/:token/unsubscribe     GET /api/c/:token/open.gif
```

---

## Field types

`text` · `email` · `tel` · `number` · `textarea` · `select` · `radio` ·
`checkbox` · `checkbox_group` · `date` · `url` · `hidden`

`select`, `radio` and `checkbox_group` need an `options` array, and submitted
values are checked against it — a tampered dropdown cannot send a value you never
offered.

---

## Security

| Layer | Stops |
|---|---|
| Allowed websites per form | Another site posting to your customer's form |
| Field whitelist | Extra keys smuggled into the body (`.unknown(false)`) |
| Locked `email` field | A form with no way to reply |
| Option whitelist | Tampered dropdown / radio values |
| HTML rejection | Markup in any text field |
| Per-IP rate limit | Flooding (counted in the DB, survives restarts) |
| Required `Origin` header | Scripts posting straight at the API, bypassing every in-page trap |
| Duplicate suppression | Retry loops, and a visitor double-clicking Send |
| Honeypot | Bots — the hidden input is part of the generated snippet |
| Random-text filter *(optional)* | Generated filler like `dpzuDpOBLOdlervZvhwuJlQ` |
| reCAPTCHA v3 *(optional)* | Sophisticated bots |
| AES-256-GCM | SMTP passwords readable in a DB dump |
| Header sanitising | Mail-header injection through the subject |

Choices worth knowing:

- **Store first, mail second.** The submission is saved before SMTP is tried, so
  a mail outage loses a notification, never the enquiry. Failed ones are
  resendable from the panel.
- **Bots get a fake success.** A honeypot hit returns the normal thank-you and
  logs the row as `spam`. A 403 would tell the author which field to leave blank.
- **`From` is never forged.** The sender's address goes in `Reply-To`, so replying
  reaches them while SPF/DKIM stay valid.
- **Passwords never come back.** No endpoint returns a stored SMTP password.
- **Templates cannot execute.** `{{field}}` substitution with escaping only.

### Why the `Origin` header is the check that matters

The honeypot, the `_ts` time trap and the reCAPTCHA token all originate in the
page. A script that never loads the page skips all three by simply leaving them
out of the payload, and the only thing left standing is the per-IP rate limit —
which a bot rotating addresses never reaches. That is not a hypothetical: it is
how a run of 83 messages landed in a customer's inbox over six days in August
2026, every one of them accepted and mailed.

Browsers send `Origin` on every form POST, cross-origin and same-origin alike.
A curl or Python client sends none. So **Security → Require a browser Origin
header** is what separates the two, and it costs a real visitor nothing.

- Fill in **Allowed websites** first. With the box ticked and the list empty,
  every submission is blocked.
- Untick it only for a form the customer submits from their own backend.
- Existing forms were migrated with it on wherever an allowlist was already
  filled in, and off where one was not.

### The other two settings

**Ignore an identical repeat within N minutes** (default 10). The same values
twice inside the window are stored once and mailed once.

**Drop messages that are random characters** (off by default). Scores the
free-text fields for generated filler. It is the only check that can misjudge a
real person, so it is opt-in, it never looks at names, emails or phone numbers,
and everything it catches is kept under Submissions marked `spam` — review it
there before trusting it.

### Before production

- [ ] Fresh `ENCRYPTION_KEY` and `SECRET_CODE` — never reuse the dev values
- [ ] `NODE_ENV=production`
- [ ] `FRONTEND_ORIGIN` = your admin panel URL only
- [ ] `BACKEND_HOST` = your real host(s)
- [ ] HTTPS everywhere (`trust proxy` is already set for nginx)
- [ ] `.env` is gitignored — confirm it is never committed
- [ ] Back up `ENCRYPTION_KEY` separately from the database

---

## Email templates

Per form, per type (`admin` = to the customer, `autoreply` = to the sender).

| Placeholder | Renders |
|---|---|
| `{{field_key}}` | that field's value, HTML-escaped |
| `{{#all_fields}}` | a table of everything submitted |
| `{{_date}}` `{{_ip}}` | request metadata |
| `{{_form_name}}` `{{_tenant_name}}` | names |

Use `{{#all_fields}}` in the notification — it stays correct when you add or
remove fields later, whereas a hand-written row per field goes stale.

---

## Campaigns

One designed email, sent to a whole list from a customer's own mailbox — one
recipient at a time, personalised, with attachments.

**Campaigns → New campaign**, then four steps:

1. **Details** — the customer to send from (any customer with SMTP set up), the
   From name, the subject and the preview text. An inbox mock-up shows what a
   recipient sees before opening.
2. **Recipients** — upload a CSV (format below) or paste addresses.
3. **Design & content** — pick a design, write the message, attach files. The
   live preview is the real email for a real row of the list.
4. **Review & send** — a checklist, a test email to yourself, speed and daily
   limit, then send now or schedule.

The **Report** then shows sent, opened, failed and unsubscribed — per person, live.

### The CSV

```csv
email,first_name,last_name,company,city
priya@acmetextiles.in,Priya,Raman,Acme Textiles,Coimbatore
rajesh@globexsteel.com,Rajesh,Kumar,Globex Steel,Chennai
```

| Column | |
|---|---|
| `email` | **Required.** `E-mail`, `Email ID` and `Email Address` also work. |
| `first_name` | For "Hi Priya". Taken from `name` when missing — "Dr. Priya Raman" gives Priya. |
| `company` | Optional. `Company Name` and `Organisation` also work. |
| anything else | Becomes a merge field: a `city` column gives `{{city}}`. |

- From Excel: **File → Save As → CSV UTF-8**. Semicolon- and tab-separated files,
  Excel's "Unicode Text", and a bare list of addresses with no header all work.
- Up to 20,000 rows and 5 MB. Invalid addresses, misspelt domains (`gmial.com`)
  and duplicates are skipped and listed with their row numbers.
- Anyone who unsubscribed from that customer before is left out automatically.

### Merge fields

`{{first_name}}`, `{{company}}` or any column of the CSV. Give one a fallback for
rows where it is empty: `Hi {{first_name|there}},` becomes "Hi Priya," or
"Hi there,". They work in the subject, preview text, headline, message, button,
signature and footer.

### Designs

| Design | Best for |
|---|---|
| Executive | Proposals and company profiles — a calm white card |
| Spotlight | Launches and announcements — brand header, big button |
| Aurora | Offers and events — vivid gradient hero |
| Personal | First contact — looks typed by a person; the likeliest to reach Gmail's Primary tab |
| Custom HTML | Your own HTML; merge fields still work |

Every design is table-based with inline styles (Gmail, Outlook, Apple Mail,
phones), adapts its text colours to the brand colour, names the attachments in
the body, and is sent with a plain-text part. The message box understands
`**bold**`, `- lists`, `1. lists`, `## headings`, `[links](https://…)` and `---`.

### Attachments

PDF, PowerPoint, Word, Excel, images — up to 10 files and 15 MB per email.
Executables (`.exe`, `.js`, `.bat`, …) are refused at upload: Gmail and Outlook
bounce any email that carries one.

In a Custom HTML design, an attached image can appear inside the email instead:
write `<img src="cid:logo.png">` with the file's exact name. The image travels
inside the message (inline, `multipart/related`), so it needs no website to host
it and shows without the reader having to allow images. The preview shows it,
and starting the campaign is refused while the HTML uses an image nobody uploaded.

### How sending works

- **One email per recipient, never Bcc.** Each is personalised, carries its own
  unsubscribe link, and a bad address fails only itself.
- **A background sender** inside the API process works through the queue at the
  campaign's speed (20 a minute by default), with an optional daily limit that
  waits and then continues by itself. Its state lives in the database, so a
  restart or deploy resumes exactly where it stopped.
- **Unsubscribe** is in every email twice: a visible link, and the
  `List-Unsubscribe` one-click header that Gmail and Yahoo require for bulk mail.
  It applies per customer, to all of its future campaigns. Someone who replied
  "please remove me" goes in **Campaigns → Do-not-email list**.
- **Failures are handled by kind:**
  - a bad address — that row fails, sending carries on
  - "try again later" or an unreachable server — retried automatically after 1, 2, 5, 10, then 15 minutes
  - wrong password, daily quota reached, message too large — the campaign **pauses**
    and says why; fix it and press Resume
  - ten failures in a row — pauses, to protect the account's reputation
- **Opens** are counted with a 1-pixel image (it can be switched off per
  campaign). They are approximate: Apple Mail loads images for privacy, and some
  inboxes block them.

### Getting into the inbox

1. Set up SPF, DKIM and DMARC on the customer's domain — the biggest single factor.
2. Warm up a new mailbox: 30–50 a day for the first week, then grow.
3. Gmail allows about 500 recipients a day, Google Workspace about 2,000 — set the daily limit.
4. Personalise the subject, always write preview text, and skip ALL CAPS and "FREE!!!".
5. For first contact use the Personal design, and keep attachments small (a PDF
   under ~2 MB) or send a link.
6. Only email people who would expect to hear from you.

> The sender runs inside the API process. Keep pm2 at a single instance, as
> `ecosystem.config.js` does — two processes would each send at full speed.

---

## Troubleshooting

**`403` "This form is not enabled for this website."** — the site's origin is not
in **Allowed websites**. Include `https://`, and add www and non-www separately.

**`400` `"purpose" is not allowed`** — you posted a key that is not a field on
*that* form. Check you are using the right form key.

**SMTP test fails on Gmail (`535-5.7.8`)** — Gmail has not accepted account
passwords for SMTP since 2022. Turn on 2-Step Verification, create an App
Password at myaccount.google.com/apppasswords, and paste the 16 characters with
the spaces removed. The username must be the full email address, and "From
email" must match it.

**Mail sends but lands in spam** — `from_email` must be a real mailbox on a domain
whose SPF record authorises this SMTP server.

**Status `failed` in the panel** — SMTP broke, the enquiry is safe. Fix the
credentials, then **Resend** from the submission page.

**Campaign paused: "reached its sending limit"** — the mailbox's daily quota is
used up. Resume it the next day, and set a daily limit on the campaign so it
spreads itself out.

**A PDF attaches but a bigger file (a PowerPoint deck) does not** — nginx on the
server still has its old 2 MB limit. The panel says the server refused the
upload. See *Upgrading to Campaigns* in DEPLOY.md.
