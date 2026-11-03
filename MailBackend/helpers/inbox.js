/**
 * Replies to campaign emails, counted from the customer's own inbox.
 *
 * The campaign's sending account doubles as the reader: same username and
 * (app) password, over IMAP, with the inbox opened read-only (EXAMINE) —
 * nothing in it changes, nothing is marked read or moved.
 *
 * Every few minutes each customer with a recent campaign is checked for new
 * messages since the last one seen. A message marks its recipient "replied"
 * when it answers one of our emails (its In-Reply-To or References name our
 * Message-ID) or comes from someone on a campaign list after we emailed them;
 * an out-of-office answer does not count. A bounce from the mail system marks
 * that address failed and puts it on the do-not-email list — mailing it again
 * would only cost the domain its reputation.
 *
 *   CAMPAIGN_INBOX_MINUTES   how often each inbox is read   (default 2)
 *   CAMPAIGN_IMAP_PORT       the mail server's IMAP port    (default 993, TLS)
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const POSTGRESQLService = require('./POSTGRES');
const { decrypt } = require('./crypto');
const logger = require('./logger');

const EVERY_MINUTES = Math.max(1, Number(process.env.CAMPAIGN_INBOX_MINUTES) || 2);
const IMAP_PORT = Number(process.env.CAMPAIGN_IMAP_PORT) || 993;
/** Campaigns started within this many days still have their replies counted. */
const LOOK_BACK_DAYS = 60;
/** New messages handled per check; any more wait for the next one. */
const MAX_PER_CHECK = 300;
/** After a failed login, wait this long before trying again — repeated failures can get a mailbox locked. */
const RETRY_AFTER_ERROR_MINUTES = 30;

const KNOWN_HOSTS = {
    'smtp.gmail.com': 'imap.gmail.com',
    'smtp.googlemail.com': 'imap.gmail.com',
    'smtp.office365.com': 'outlook.office365.com',
    'smtp-mail.outlook.com': 'outlook.office365.com',
    'smtp.mail.yahoo.com': 'imap.mail.yahoo.com',
    'smtpout.secureserver.net': 'imap.secureserver.net'
};

/** A plain-text bounce (no delivery report attached) counts only when it is clearly final. */
const PERMANENT = /could not be delivered|wasn't delivered|undeliverable|delivery (has )?failed|does ?n[o']t exist|user unknown|no such (user|mailbox)|address not found|(address|recipient) rejected|mailbox unavailable/i;
const DELAYED = /delayed|will (keep )?(try|retry)|temporar|not yet been delivered/i;

/** Where the sending account reads its mail: smtp.gmail.com -> imap.gmail.com, smtp.x.com -> imap.x.com. */
function imapHostFor(smtpHost) {
    const host = String(smtpHost || '').trim().toLowerCase();
    if (KNOWN_HOSTS[host]) return KNOWN_HOSTS[host];
    return host.startsWith('smtp.') ? `imap.${host.slice(5)}` : host;
}

/** "<a@b> <c@d>" — every Message-ID in a header, brackets kept, as we stored ours. */
function idsIn(...values) {
    const ids = [];
    for (const value of values.flat()) {
        for (const m of String(value || '').matchAll(/<[^<>\s]+>/g)) if (!ids.includes(m[0])) ids.push(m[0]);
    }
    return ids;
}

/** Out-of-office and other machine answers: not a reply. */
function isAuto(parsed) {
    const h = parsed.headers;
    const auto = String(h.get('auto-submitted') || '').toLowerCase();
    if (auto && auto !== 'no') return true;
    if (h.has('x-autoreply') || h.has('x-autorespond') || /auto_reply/i.test(String(h.get('precedence') || ''))) return true;
    return /^(automatic reply|auto(matic)?[ -]?reply|out of (the )?office|autoreply|away from)/i.test(parsed.subject || '');
}

/** A "could not deliver" report: which addresses failed for good, and the mail server's reason. */
function bounceOf(parsed, from) {
    const type = parsed.headers.get('content-type');
    const report = /multipart\/report/i.test(String((type && type.value) || type || '')) || /^(mailer-daemon|postmaster)@/i.test(from);
    if (!report) return null;
    const status = (parsed.attachments || []).find((a) => /delivery-status/i.test(a.contentType || ''));
    const text = status ? status.content.toString('utf8') : String(parsed.text || '');
    if (status ? !/Action:\s*failed/i.test(text) && !/Status:\s*5\.\d+\.\d+/i.test(text) : !PERMANENT.test(text) || DELAYED.test(text)) {
        return null;   // only delayed — the mail server is still trying
    }
    let emails = [...text.matchAll(/Final-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/gi)].map((m) => m[1].toLowerCase());
    if (!emails.length) emails = [...String(parsed.text || '').matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());
    const reason = ((/Diagnostic-Code:\s*(?:smtp;\s*)?([^\n]+(?:\n[ \t]+[^\n]+)*)/i.exec(text) || [])[1] || 'The address could not be found.')
        .replace(/\s+/g, ' ').trim().slice(0, 300);
    return { emails: [...new Set(emails)], reason };
}

/**
 * The list row a message belongs to: by our Message-ID first, else by who sent
 * it after we emailed them (with two minutes' grace for clocks that differ —
 * an answer can arrive within seconds).
 */
async function recipientFor(tenantId, { ids, email, at }) {
    if (ids.length) {
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT r.id, r.campaign_id FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
              WHERE c.tenant_id = $1 AND r.message_id = ANY($2::text[]) LIMIT 1`,
            [tenantId, ids]
        );
        if (rows.length) return rows[0];
    }
    if (!email) return null;
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT r.id, r.campaign_id FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
          WHERE c.tenant_id = $1 AND r.email = $2 AND r.sent_at IS NOT NULL AND r.sent_at <= $3::timestamptz + interval '2 minutes'
          ORDER BY r.sent_at DESC LIMIT 1`,
        [tenantId, email, at]
    );
    return rows[0] || null;
}

/**
 * One message from the inbox: a reply, a bounce — or nothing to do with
 * campaigns. `at` is when the inbox received it.
 */
async function handle(tenantId, parsed, at) {
    const sender = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
    const email = String(sender.address || '').toLowerCase();

    const bounce = bounceOf(parsed, email);
    if (bounce) {
        let any = false;
        for (const address of bounce.emails) {
            const r = await recipientFor(tenantId, { ids: [], email: address, at: new Date() });
            if (!r) continue;
            any = true;
            await POSTGRESQLService.PostgresAny(
                `UPDATE campaign_recipients SET status = 'failed', error = $2 WHERE id = $1 AND status = 'sent'`,
                [r.id, `Bounced — the address does not accept mail. ${bounce.reason}`.slice(0, 500)]
            );
            await POSTGRESQLService.PostgresAny(
                `INSERT INTO campaign_unsubscribes (tenant_id, email, source, campaign_id) VALUES ($1, $2, 'bounce', $3)
                 ON CONFLICT (tenant_id, email) DO NOTHING`,
                [tenantId, address, r.campaign_id]
            );
        }
        return any;
    }
    if (isAuto(parsed)) return false;

    const r = await recipientFor(tenantId, { ids: idsIn(parsed.inReplyTo, parsed.references), email, at });
    if (!r) return false;
    const marked = await POSTGRESQLService.PostgresAny(
        `UPDATE campaign_recipients SET replied_at = $2 WHERE id = $1 AND replied_at IS NULL RETURNING id`,
        [r.id, at]
    );
    return marked.length > 0;
}

/** IMAP failures in words, with what to change. */
function explain(error, host) {
    const text = `${(error && error.responseText) || ''} ${(error && error.message) || ''}`;
    if ((error && error.authenticationFailed) || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authenticat/i.test(text)) {
        return `${host} refused the login for reading replies. IMAP must be allowed for this mailbox — in Google Workspace: `
            + 'admin.google.com → Apps → Google Workspace → Gmail → End User Access → POP and IMAP access. '
            + 'The App Password used for sending also works for reading.';
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(`${error && error.code} ${text}`)) {
        return `Could not reach ${host} on port ${IMAP_PORT} to read replies.`;
    }
    return `Replies could not be read from ${host}: ${text.trim().slice(0, 200)}`;
}

/** Reads one customer's inbox since last time. Returns how many messages changed a campaign. */
async function checkTenant(tenantId) {
    const smtp = (await POSTGRESQLService.PostgresAny(
        `SELECT host, username, password_enc FROM tenant_smtp WHERE tenant_id = $1 AND is_active`, [tenantId]
    ))[0];
    const first = (await POSTGRESQLService.PostgresAny(
        `SELECT min(started_at) AS at FROM campaigns WHERE tenant_id = $1 AND started_at IS NOT NULL`, [tenantId]
    ))[0].at;
    if (!smtp || !first) return 0;
    const since = new Date(Math.max(new Date(first).getTime(), Date.now() - LOOK_BACK_DAYS * 24 * 60 * 60 * 1000));

    const host = imapHostFor(smtp.host);
    const state = (await POSTGRESQLService.PostgresAny(`SELECT * FROM campaign_inbox WHERE tenant_id = $1`, [tenantId]))[0] || {};
    const saveProgress = (validity, lastUid) => POSTGRESQLService.PostgresAny(
        `INSERT INTO campaign_inbox (tenant_id, uid_validity, last_uid, checked_at, error) VALUES ($1, $2, $3, now(), NULL)
         ON CONFLICT (tenant_id) DO UPDATE SET uid_validity = $2, last_uid = $3, checked_at = now(), error = NULL`,
        [tenantId, validity, lastUid]
    );
    const saveError = (message) => POSTGRESQLService.PostgresAny(
        `INSERT INTO campaign_inbox (tenant_id, checked_at, error) VALUES ($1, now(), $2)
         ON CONFLICT (tenant_id) DO UPDATE SET checked_at = now(), error = $2`,
        [tenantId, message]
    );

    const client = new ImapFlow({
        host, port: IMAP_PORT, secure: true,
        auth: { user: smtp.username, pass: decrypt(smtp.password_enc) },
        logger: false, socketTimeout: 60 * 1000
    });
    let found = 0;
    try {
        await client.connect();
        const box = await client.mailboxOpen('INBOX', { readOnly: true });
        const validity = String(box.uidValidity);
        let lastUid = state.uid_validity === validity ? Number(state.last_uid) || 0 : 0;
        const query = lastUid ? { uid: `${lastUid + 1}:*` } : { since };
        const uids = ((await client.search(query, { uid: true })) || []).filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, MAX_PER_CHECK);

        for (const uid of uids) {
            // The envelope first: only campaign mail is downloaded whole, never a vendor's 10 MB PDF.
            // The arrival time comes from the mail server, not the sender's Date: header.
            const head = await client.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true, headers: ['references'] }, { uid: true });
            const envelope = (head && head.envelope) || {};
            const from = String(((envelope.from || [])[0] || {}).address || '').toLowerCase();
            const at = (head && head.internalDate) || envelope.date || new Date();
            const relevant = /^(mailer-daemon|postmaster)@/i.test(from)
                || await recipientFor(tenantId, { ids: idsIn(envelope.inReplyTo, head && head.headers && head.headers.toString()), email: from, at });
            if (relevant) {
                const message = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
                const parsed = await simpleParser(message.source, { skipImageLinks: true, skipTextToHtml: true });
                if (await handle(tenantId, parsed, at)) found += 1;
            }
            lastUid = uid;
        }
        await saveProgress(validity, lastUid);
        if (found) logger.info('Campaign replies read', { tenantId, found });
        return found;
    } catch (error) {
        logger.warn('Campaign inbox could not be read', { tenantId, host, error: error.message });
        await saveError(explain(error, host)).catch(() => {});
        throw new Error(explain(error, host));
    } finally {
        await client.logout().catch(() => {});
    }
}

let timer = null;
let running = false;

/**
 * Every customer with a recent campaign, one after another — one IMAP
 * connection at a time. A mailbox whose last read failed rests for a while.
 */
async function checkAll() {
    if (running) return;
    running = true;
    try {
        const tenants = await POSTGRESQLService.PostgresAny(
            `SELECT DISTINCT c.tenant_id FROM campaigns c
               JOIN tenant_smtp s ON s.tenant_id = c.tenant_id AND s.is_active
               LEFT JOIN campaign_inbox i ON i.tenant_id = c.tenant_id
              WHERE c.started_at > now() - make_interval(days => $1)
                AND (i.error IS NULL OR i.checked_at < now() - make_interval(mins => $2))`,
            [LOOK_BACK_DAYS, RETRY_AFTER_ERROR_MINUTES]
        );
        for (const { tenant_id: tenantId } of tenants) await checkTenant(tenantId).catch(() => {});
    } finally {
        running = false;
    }
}

function start() {
    if (timer) return;
    setTimeout(() => checkAll().catch(() => {}), 30 * 1000);
    timer = setInterval(() => checkAll().catch(() => {}), EVERY_MINUTES * 60 * 1000);
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, checkAll, checkTenant, imapHostFor, isAuto, bounceOf, idsIn };
