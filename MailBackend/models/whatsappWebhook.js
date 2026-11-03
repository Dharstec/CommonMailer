/**
 * Meta's calls about WhatsApp: delivery receipts and replies.
 *
 *   GET  /api/wa/webhook   the one-time check when the webhook is set up in the Meta app
 *   POST /api/wa/webhook   statuses (sent, delivered, read, failed) and incoming messages
 *
 * Every POST is signed with the Meta app's secret (X-Hub-Signature-256). A call
 * that matches no connected account's secret is refused, so nobody can fake a
 * reply, an opt-out or a delivery.
 */
const crypto = require('crypto');
const POSTGRESQLService = require('../helpers/POSTGRES');
const { decrypt } = require('../helpers/crypto');
const whatsapp = require('../helpers/whatsapp');
const mailer = require('../helpers/mailer');
const { escapeHtml } = require('../helpers/template');
const { formatPhone } = require('../helpers/phone');
const logger = require('../helpers/logger');

/** Replies that mean "stop messaging me". A marketing template's opt-out button says "Stop promotions". */
const STOP_WORDS = /^\s*(stop|stop promotions|unsubscribe|opt[ -]?out|remove me|don'?t message( me)?|no more messages)\b/i;

const verify = async (req, res) => {
    try {
        const token = String(req.query['hub.verify_token'] || '');
        if (req.query['hub.mode'] === 'subscribe' && token) {
            const rows = await POSTGRESQLService.PostgresAny(
                `UPDATE whatsapp_accounts SET webhook_seen_at = now() WHERE verify_token = $1 RETURNING tenant_id`, [token]
            );
            if (rows.length) {
                logger.info('WhatsApp webhook verified', { tenantId: rows[0].tenant_id });
                return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
            }
        }
        res.status(403).end();
    } catch (error) {
        logger.error('WhatsApp webhook verification failed', { error: error.message });
        res.status(500).end();
    }
};

function signedBy(raw, signature, secret) {
    const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
    const given = Buffer.from(String(signature));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const at = (timestamp) => (timestamp ? new Date(Number(timestamp) * 1000) : new Date());

/**
 * Moves a recipient forward — sent, delivered, read — and never back: Meta
 * does not promise the order. Returns how many rows it found.
 */
async function applyStatus(account, s) {
    const when = at(s.timestamp);
    if (s.status === 'failed') {
        const error = (s.errors && s.errors[0]) || {};
        const failure = new whatsapp.WhatsAppError(error.title || error.message || 'Not delivered', {
            code: error.code, details: (error.error_data && error.error_data.details) || ''
        });
        const rows = await POSTGRESQLService.PostgresAny(
            `UPDATE wa_recipients r SET status = 'failed', error = $3
               FROM wa_campaigns c
              WHERE r.wa_message_id = $1 AND c.id = r.campaign_id AND c.tenant_id = $2 AND r.status IN ('sending', 'sent')
             RETURNING r.phone, r.campaign_id`,
            [s.id, account.tenant_id, whatsapp.explain(failure)]
        );
        if (rows.length && failure.code === 131050) {
            await POSTGRESQLService.PostgresAny(
                `INSERT INTO wa_optouts (tenant_id, phone, source, campaign_id) VALUES ($1, $2, 'button', $3)
                 ON CONFLICT (tenant_id, phone) DO NOTHING`,
                [account.tenant_id, rows[0].phone, rows[0].campaign_id]
            );
        }
        return rows.length;
    }

    const step = { sent: 1, delivered: 2, read: 3 }[s.status];
    if (!step) return 1;
    const rows = await POSTGRESQLService.PostgresAny(
        `UPDATE wa_recipients r
            SET status = CASE
                    WHEN $3 = 3 AND r.status IN ('sending', 'sent', 'delivered') THEN 'read'
                    WHEN $3 = 2 AND r.status IN ('sending', 'sent') THEN 'delivered'
                    WHEN $3 = 1 AND r.status = 'sending' THEN 'sent'
                    ELSE r.status END,
                sent_at = COALESCE(r.sent_at, $4),
                delivered_at = CASE WHEN $3 >= 2 THEN COALESCE(r.delivered_at, $4) ELSE r.delivered_at END,
                read_at = CASE WHEN $3 = 3 THEN COALESCE(r.read_at, $4) ELSE r.read_at END
           FROM wa_campaigns c
          WHERE r.wa_message_id = $1 AND c.id = r.campaign_id AND c.tenant_id = $2
         RETURNING r.id`,
        [s.id, account.tenant_id, step, when]
    );
    return rows.length;
}

/** What a message says, in words — text, a button pressed, or what kind of file it was. */
function textOf(m) {
    if (m.type === 'text') return (m.text && m.text.body) || '';
    if (m.type === 'button') return (m.button && (m.button.text || m.button.payload)) || '';
    if (m.type === 'interactive') {
        const i = m.interactive || {};
        return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '[reply]';
    }
    if (m.type === 'reaction') return `[reacted ${(m.reaction && m.reaction.emoji) || ''}]`.trim();
    const media = m[m.type] || {};
    return `[${m.type}${media.caption ? `: ${media.caption}` : ''}]`;
}

/** Emails the reply to the customer's team, through its own mailbox, so nobody has to watch the panel. */
async function notify(account, { phone, name, body, campaign, optedOut }) {
    const to = String(account.notify_emails || '').split(/[\s,;]+/).filter(Boolean);
    if (!to.length) return;
    const who = [name, formatPhone(phone)].filter(Boolean).join(' · ');
    const panel = String(process.env.FRONTEND_ORIGIN || '').split(',')[0].trim();
    const link = panel && campaign ? `${panel}/whatsapp/${campaign.id}` : '';
    const note = optedOut ? 'They asked to stop, so they are on the do-not-message list now.' : 'You can reply from the campaign\'s report for 24 hours.';
    try {
        await mailer.sendMail(account.tenant_id, {
            to,
            subject: `WhatsApp reply from ${name || formatPhone(phone)}`,
            html: `<p style="font-family:Arial,sans-serif;font-size:15px;color:#111827;"><strong>${escapeHtml(who)}</strong>`
                + `${campaign ? ` replied to <em>${escapeHtml(campaign.name)}</em>` : ' wrote'}:</p>`
                + `<blockquote style="font-family:Arial,sans-serif;font-size:16px;margin:0 0 16px;padding:10px 14px;border-left:4px solid #25D366;background:#f0fdf4;color:#111827;white-space:pre-wrap;">${escapeHtml(body)}</blockquote>`
                + `<p style="font-family:Arial,sans-serif;font-size:13px;color:#4b5563;">${escapeHtml(note)}`
                + `${link ? ` <a href="${escapeHtml(link)}">Open the campaign</a>` : ''}</p>`,
            text: `${who}${campaign ? ` replied to "${campaign.name}"` : ' wrote'}:\n\n${body}\n\n${note}${link ? `\n${link}` : ''}`
        });
    } catch (error) {
        logger.warn('WhatsApp reply could not be emailed', { tenantId: account.tenant_id, error: error.message });
    }
}

async function receiveMessage(account, m, contacts) {
    const phone = String(m.from || '').replace(/\D/g, '');
    if (!phone) return;
    const body = textOf(m).slice(0, 4096);

    // The latest campaign that messaged this number is the one they are answering.
    const recipient = (await POSTGRESQLService.PostgresAny(
        `SELECT r.id, r.data, c.id AS campaign_id, c.name AS campaign_name
           FROM wa_recipients r JOIN wa_campaigns c ON c.id = r.campaign_id
          WHERE c.tenant_id = $1 AND r.phone = $2 AND r.attempted_at IS NOT NULL
          ORDER BY r.attempted_at DESC LIMIT 1`,
        [account.tenant_id, phone]
    ))[0];

    // Meta resends a call it thinks was missed: the message id makes it a no-op.
    const stored = await POSTGRESQLService.PostgresAny(
        `INSERT INTO wa_messages (tenant_id, campaign_id, phone, direction, body, wa_message_id)
         VALUES ($1, $2, $3, 'in', $4, $5) ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
        [account.tenant_id, recipient ? recipient.campaign_id : null, phone, body, m.id || null]
    );
    if (!stored.length) return;

    if (recipient) {
        await POSTGRESQLService.PostgresAny(`UPDATE wa_recipients SET replied_at = COALESCE(replied_at, now()) WHERE id = $1`, [recipient.id]);
    }

    let optedOut = false;
    if (STOP_WORDS.test(body)) {
        const added = await POSTGRESQLService.PostgresAny(
            `INSERT INTO wa_optouts (tenant_id, phone, source, campaign_id) VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, phone) DO NOTHING RETURNING id`,
            [account.tenant_id, phone, m.type === 'text' ? 'reply' : 'button', recipient ? recipient.campaign_id : null]
        );
        optedOut = added.length > 0;
    }

    const profile = (contacts || []).find((c) => String(c.wa_id) === phone);
    const data = (recipient && recipient.data) || {};
    const name = [data.first_name || (profile && profile.profile && profile.profile.name), data.company].filter(Boolean).join(', ');
    await notify(account, {
        phone, name, body, optedOut,
        campaign: recipient ? { id: recipient.campaign_id, name: recipient.campaign_name } : null
    });
}

const receive = async (req, res) => {
    try {
        const raw = req.rawBody;
        const signature = req.get('x-hub-signature-256');
        const accounts = await POSTGRESQLService.PostgresAny(
            `SELECT id, tenant_id, phone_number_id, app_secret_enc, notify_emails FROM whatsapp_accounts WHERE is_active`, []
        );
        const secrets = accounts.map((a) => ({ ...a, secret: decrypt(a.app_secret_enc) }));
        const signer = raw && signature ? secrets.find((a) => signedBy(raw, signature, a.secret)) : null;
        if (!signer) {
            logger.warn('WhatsApp webhook refused: signature matches no connected account', { ip: req.ip });
            return res.status(401).end();
        }
        // Answer at once — Meta retries anything slow — then do the work.
        res.status(200).end();

        const trusted = secrets.filter((a) => a.secret === signer.secret);
        for (const entry of (req.body && req.body.entry) || []) {
            for (const change of entry.changes || []) {
                const value = change.value || {};
                const account = trusted.find((a) => a.phone_number_id === String((value.metadata || {}).phone_number_id || ''));
                if (!account) continue;
                await POSTGRESQLService.PostgresAny(`UPDATE whatsapp_accounts SET webhook_seen_at = now() WHERE id = $1`, [account.id]);

                for (const status of value.statuses || []) {
                    // The receipt can beat the send's own answer by a moment: look once more shortly after.
                    if (!await applyStatus(account, status)) setTimeout(() => applyStatus(account, status).catch(() => {}), 3000);
                }
                for (const message of value.messages || []) await receiveMessage(account, message, value.contacts);
            }
        }
    } catch (error) {
        logger.error('WhatsApp webhook failed', { error: error.message, stack: error.stack });
        if (!res.headersSent) res.status(500).end();
    }
};

module.exports = { verify, receive, STOP_WORDS };
