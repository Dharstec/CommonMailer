/**
 * Nodemailer transports, one per customer, built lazily and cached.
 *
 * Creating a transport per email would open a new TLS handshake every time; a
 * pooled transport per tenant reuses connections and keeps us inside the rate
 * limits that providers like Gmail/Zoho enforce. The cache is invalidated from
 * the admin panel whenever SMTP settings are saved, so a credential change
 * takes effect immediately without a restart.
 */
const nodemailer = require('nodemailer');
const POSTGRESQLService = require('./POSTGRES');
const { decrypt } = require('./crypto');
const logger = require('./logger');

// `${tenant_id}:${purpose}` -> { transporter, signature }
const cache = new Map();

/**
 * How long to wait for the mail server, by purpose.
 *
 * A form notification is sent while the visitor's request waits, so it gives up
 * quickly. A campaign message can carry megabytes of attachments, and after the
 * last byte the server checks them before it replies "accepted". RFC 5321
 * (4.5.3.2.6) asks clients to wait up to 10 minutes for that reply, because
 * giving up sooner is exactly how a message gets delivered twice: the server
 * had already taken it, and the sender, not knowing, sends it again.
 */
const TIMEOUTS = {
    form: { connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 },
    bulk: { connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 10 * 60 * 1000 }
};

/** Identifies the config a cached transport was built from. */
function signatureOf(smtp) {
    return [smtp.host, smtp.port, smtp.secure, smtp.username, smtp.password_enc, smtp.from_email].join('|');
}

async function loadSmtpRow(tenantId) {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT * FROM tenant_smtp WHERE tenant_id = $1 AND is_active = true`,
        [tenantId]
    );
    return rows[0] || null;
}

function buildTransporter(smtp, password, purpose) {
    return nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port),
        // secure=true means implicit TLS (port 465). For 587 we stay false and
        // require STARTTLS instead — never send credentials in the clear.
        secure: Boolean(smtp.secure),
        requireTLS: !smtp.secure,
        auth: { user: smtp.username, pass: password },
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
        ...TIMEOUTS[purpose],
        tls: {
            // Reject self-signed / mismatched certificates. Turning this off is
            // the usual "fix" for SMTP errors and it silently disables TLS
            // verification, so it stays on.
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2'
        }
    });
}

/**
 * @param {number} tenantId
 * @param {'form'|'bulk'} [purpose]  decides the timeouts; each gets its own pool
 * @returns {{transporter: object, smtp: object}}
 * @throws if the tenant has no active SMTP configuration
 */
async function getTransporter(tenantId, purpose = 'form') {
    const smtp = await loadSmtpRow(tenantId);
    if (!smtp) {
        throw new Error('No active SMTP configuration for this customer. Add it in the admin panel.');
    }

    const key = `${tenantId}:${purpose}`;
    const signature = signatureOf(smtp);
    const cached = cache.get(key);
    if (cached && cached.signature === signature) {
        return { transporter: cached.transporter, smtp };
    }

    if (cached) cached.transporter.close();

    const password = decrypt(smtp.password_enc);
    const transporter = buildTransporter(smtp, password, purpose);
    cache.set(key, { transporter, signature });

    return { transporter, smtp };
}

/** Called after SMTP settings are saved so the next send picks up new values. */
function invalidate(tenantId) {
    for (const purpose of Object.keys(TIMEOUTS)) {
        const key = `${tenantId}:${purpose}`;
        const cached = cache.get(key);
        if (cached) {
            cached.transporter.close();
            cache.delete(key);
        }
    }
}

/**
 * Sends one message on the customer's own account.
 *
 * `replyTo` is how the customer replies straight to the visitor even though the
 * mail is sent from their own mailbox — this is what keeps SPF/DKIM valid. We
 * never forge the visitor's address in From, which would land the mail in spam.
 *
 * `fromName` / `fromEmail` let a campaign present itself differently ("Gokul at
 * Dharstec", or an alias the mailbox may send as). The address object is passed
 * to Nodemailer rather than a hand-built string so a name containing quotes or
 * non-ASCII characters is encoded correctly.
 *
 * `bulk` marks a campaign message: it gets the long reply wait (see TIMEOUTS).
 */
async function sendMail(tenantId, {
    to, cc, bcc, subject, html, text, replyTo, fromName, fromEmail, attachments, headers, bulk = false
}) {
    const { transporter, smtp } = await getTransporter(tenantId, bulk ? 'bulk' : 'form');

    const info = await transporter.sendMail({
        from: { name: fromName || smtp.from_name, address: fromEmail || smtp.from_email },
        to: Array.isArray(to) ? to.join(', ') : to,
        cc: cc && cc.length ? cc.join(', ') : undefined,
        bcc: bcc && bcc.length ? bcc.join(', ') : undefined,
        replyTo: replyTo || smtp.reply_to || undefined,
        subject,
        html,
        text,
        attachments: attachments && attachments.length ? attachments : undefined,
        headers: headers || undefined
    });

    logger.info('Mail sent', { tenantId, to, subject, messageId: info.messageId });
    return info;
}

/** Proves the stored credentials actually work, used by the "Test" button. */
async function verifyConnection(tenantId) {
    const { transporter } = await getTransporter(tenantId);
    await transporter.verify();
    await POSTGRESQLService.PostgresAny(
        `UPDATE tenant_smtp SET verified_at = now() WHERE tenant_id = $1`,
        [tenantId]
    );
    return true;
}

module.exports = { sendMail, verifyConnection, invalidate, getTransporter };
