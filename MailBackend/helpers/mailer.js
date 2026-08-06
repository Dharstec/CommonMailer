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

// tenant_id -> { transporter, signature }
const cache = new Map();

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

function buildTransporter(smtp, password) {
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
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
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
 * @returns {{transporter: object, smtp: object}}
 * @throws if the tenant has no active SMTP configuration
 */
async function getTransporter(tenantId) {
    const smtp = await loadSmtpRow(tenantId);
    if (!smtp) {
        throw new Error('No active SMTP configuration for this customer. Add it in the admin panel.');
    }

    const signature = signatureOf(smtp);
    const cached = cache.get(tenantId);
    if (cached && cached.signature === signature) {
        return { transporter: cached.transporter, smtp };
    }

    if (cached) cached.transporter.close();

    const password = decrypt(smtp.password_enc);
    const transporter = buildTransporter(smtp, password);
    cache.set(tenantId, { transporter, signature });

    return { transporter, smtp };
}

/** Called after SMTP settings are saved so the next send picks up new values. */
function invalidate(tenantId) {
    const cached = cache.get(tenantId);
    if (cached) {
        cached.transporter.close();
        cache.delete(tenantId);
    }
}

/**
 * Sends one message on the customer's own account.
 *
 * `replyTo` is how the customer replies straight to the visitor even though the
 * mail is sent from their own mailbox — this is what keeps SPF/DKIM valid. We
 * never forge the visitor's address in From, which would land the mail in spam.
 */
async function sendMail(tenantId, { to, cc, bcc, subject, html, text, replyTo }) {
    const { transporter, smtp } = await getTransporter(tenantId);

    const info = await transporter.sendMail({
        from: `"${smtp.from_name}" <${smtp.from_email}>`,
        to: Array.isArray(to) ? to.join(', ') : to,
        cc: cc && cc.length ? cc.join(', ') : undefined,
        bcc: bcc && bcc.length ? bcc.join(', ') : undefined,
        replyTo: replyTo || smtp.reply_to || undefined,
        subject,
        html,
        text
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
