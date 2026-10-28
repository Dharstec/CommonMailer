/**
 * Background sender for campaigns.
 *
 * Runs inside the API process — pm2 runs exactly one (ecosystem.config.js) —
 * and ticks once a second. All of its state lives in the database: the queue
 * is campaign_recipients.status and the throttle is campaigns.next_send_at. A
 * restart or deploy therefore resumes every campaign where it stopped, and
 * pausing from the panel is just a status change the next tick respects.
 *
 * One message per recipient, never Bcc: each is personalised, carries its own
 * unsubscribe link, and a bad address fails only its own row.
 */
const POSTGRESQLService = require('./POSTGRES');
const mailer = require('./mailer');
const { renderCampaign, mailAttachments } = require('./campaignRender');
const { campaignLinks } = require('./links');
const { explainSmtpError } = require('./smtpErrors');
const logger = require('./logger');

const TICK_MS = 1000;
const BACKOFF_MINUTES = [1, 2, 5, 10, 15];
const FAILURE_STREAK_LIMIT = 10;

const INTERRUPTED = 'The server restarted while this message was being sent, so it may or may not have '
    + 'been delivered. Retry it only if you are sure it did not arrive.';

const STALLED = 'The mail server stopped answering partway through this message, so it may or may not have '
    + 'arrived. Retry it only if you are sure it did not.';

let timer = null;
let ticking = false;
const inFlight = new Set();

// campaign_id -> { signature, files }. Attachments are read once per campaign
// rather than once per recipient: 15 MB times a few thousand rows adds up.
const attachmentCache = new Map();

/**
 * What a failed send says about the rest of the queue.
 *
 *   recipient  this address was refused — fail the row, carry on
 *   temporary  the server is briefly unreachable or asked us to back off —
 *              requeue the row and try again later, automatically
 *   account    login, quota, size or sender refused — every remaining message
 *              would fail the same way, so pause and say why
 *   stalled    connected and mid-message, then silence for the whole reply
 *              wait — the server may already have the message, so it is not
 *              retried on its own: that could deliver it twice
 */
function classify(error) {
    const code = error && error.code;
    const status = Number(error && error.responseCode) || 0;
    const text = String((error && (error.response || error.message)) || '');

    if (code === 'EAUTH' || [530, 534, 535].includes(status)) return 'account';
    if (/No active SMTP configuration|decrypt/i.test(text)) return 'account';
    if (/quota|sending limit|limit exceeded|daily user sending|too many (messages|recipients)|5\.4\.5/i.test(text)) return 'account';
    if (/5\.3\.4|message size|too large|size exceeds/i.test(text)) return 'account';
    // Nodemailer's plain "Timeout" is the inactivity timer of an open session;
    // timeouts before anything was sent say "Connection timeout" or "Greeting
    // never received" instead, and stay safe to retry.
    if (code === 'ETIMEDOUT' && text.trim() === 'Timeout') return 'stalled';
    if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETLS', 'EPROTOCOL'].includes(code)) {
        return 'temporary';
    }
    // 4xx means "not now", even when it arrives as a refused recipient: the
    // submission server throttles with 421/451 at whatever step it likes.
    if (status >= 400 && status < 500) return 'temporary';
    if (code === 'EENVELOPE') return 'recipient';
    if (/5\.7\.\d|not allowed|sender.*(denied|rejected)|relay/i.test(text)) return 'account';
    return 'recipient';
}

async function loadAttachments(campaignId) {
    const ids = await POSTGRESQLService.PostgresAny(
        `SELECT id FROM campaign_attachments WHERE campaign_id = $1 ORDER BY id`, [campaignId]
    );
    const signature = ids.map((r) => r.id).join(',');

    const cached = attachmentCache.get(campaignId);
    if (cached && cached.signature === signature) return cached.files;

    const files = signature
        ? await POSTGRESQLService.PostgresAny(
            `SELECT filename, content_type, size_bytes, content
               FROM campaign_attachments WHERE campaign_id = $1 ORDER BY id`,
            [campaignId]
        )
        : [];

    attachmentCache.delete(campaignId);
    attachmentCache.set(campaignId, { signature, files });
    if (attachmentCache.size > 5) attachmentCache.delete(attachmentCache.keys().next().value);
    return files;
}

async function pause(campaignId, reason) {
    await POSTGRESQLService.PostgresAny(
        `UPDATE campaigns
            SET status = 'paused', status_reason = $2, next_send_at = NULL, retry_count = 0, updated_at = now()
          WHERE id = $1 AND status = 'sending'`,
        [campaignId, reason]
    );
    logger.warn('Campaign paused automatically', { campaignId, reason });
}

function secondsBetween(campaign) {
    return 60 / Math.min(60, Math.max(1, Number(campaign.rate_per_minute) || 20));
}

async function scheduleNext(campaign) {
    await POSTGRESQLService.PostgresAny(
        `UPDATE campaigns
            SET next_send_at = now() + make_interval(secs => $2::double precision), retry_count = 0, status_reason = NULL
          WHERE id = $1 AND status = 'sending'`,
        [campaign.id, secondsBetween(campaign)]
    );
}

async function handleFailure(campaign, recipient, error) {
    const kind = classify(error);
    const message = String((error && error.message) || error).slice(0, 500);
    logger.warn('Campaign message failed', { campaignId: campaign.id, to: recipient.email, kind, error: message });

    if (kind === 'recipient' || kind === 'stalled') {
        await POSTGRESQLService.PostgresAny(
            `UPDATE campaign_recipients SET status = 'failed', error = $2 WHERE id = $1`,
            [recipient.id, kind === 'stalled' ? STALLED : message]
        );

        // Ten different addresses in a row all "bad" is really one problem —
        // the account or the message — and pressing on only burns the list.
        const recent = await POSTGRESQLService.PostgresAny(
            `SELECT status FROM campaign_recipients
              WHERE campaign_id = $1 AND status IN ('sent', 'failed')
              ORDER BY attempted_at DESC LIMIT $2`,
            [campaign.id, FAILURE_STREAK_LIMIT]
        );
        if (recent.length === FAILURE_STREAK_LIMIT && recent.every((r) => r.status === 'failed')) {
            await pause(campaign.id, `The last ${FAILURE_STREAK_LIMIT} messages all failed, so sending was paused to `
                + 'protect the account. Check the errors in the report before resuming.');
        } else {
            await scheduleNext(campaign);
        }
        return;
    }

    // Nothing was wrong with the address, so it goes back in the queue.
    await POSTGRESQLService.PostgresAny(
        `UPDATE campaign_recipients SET status = 'pending', attempted_at = NULL WHERE id = $1`,
        [recipient.id]
    );

    if (kind === 'temporary' && campaign.retry_count < BACKOFF_MINUTES.length) {
        const minutes = BACKOFF_MINUTES[campaign.retry_count];
        const firstLine = message.split('\n')[0];
        await POSTGRESQLService.PostgresAny(
            `UPDATE campaigns
                SET retry_count = retry_count + 1,
                    next_send_at = now() + make_interval(mins => $2),
                    status_reason = $3
              WHERE id = $1 AND status = 'sending'`,
            [campaign.id, minutes, `The mail server did not accept the message just now (${firstLine}). Retrying automatically.`]
        );
        return;
    }

    await pause(campaign.id, explainSmtpError(error, campaign.smtp_host || ''));
}

/**
 * At most one message per call. The throttle is the time between calls, kept
 * in next_send_at; this function only decides whether there is anything to do.
 */
async function sendNext(campaign) {
    // Daily cap over a rolling 24 hours: when it is reached, wait until the
    // oldest message in the window ages out, then carry on by itself.
    if (campaign.daily_limit > 0) {
        const window = await POSTGRESQLService.PostgresAny(
            `SELECT count(*)::int AS total, min(attempted_at) AS oldest
               FROM campaign_recipients
              WHERE campaign_id = $1 AND status IN ('sent', 'failed')
                AND attempted_at > now() - interval '24 hours'`,
            [campaign.id]
        );
        if (window[0].total >= campaign.daily_limit) {
            await POSTGRESQLService.PostgresAny(
                `UPDATE campaigns
                    SET next_send_at = $2::timestamptz + interval '24 hours 5 seconds', status_reason = $3
                  WHERE id = $1 AND status = 'sending'`,
                [campaign.id, window[0].oldest, `Daily limit of ${campaign.daily_limit} reached. Sending continues by itself.`]
            );
            return;
        }
    }

    const claimed = await POSTGRESQLService.PostgresAny(
        `UPDATE campaign_recipients SET status = 'sending', attempted_at = now()
          WHERE id = (
              SELECT r.id FROM campaign_recipients r
               WHERE r.campaign_id = $1 AND r.status = 'pending'
                 AND EXISTS (SELECT 1 FROM campaigns c WHERE c.id = $1 AND c.status = 'sending')
               ORDER BY r.id
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
        RETURNING *`,
        [campaign.id]
    );
    const recipient = claimed[0];

    if (!recipient) {
        const done = await POSTGRESQLService.PostgresAny(
            `UPDATE campaigns
                SET status = 'completed', completed_at = now(), next_send_at = NULL, status_reason = NULL, updated_at = now()
              WHERE id = $1 AND status = 'sending'
                AND NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = $1 AND status IN ('pending', 'sending'))
            RETURNING id`,
            [campaign.id]
        );
        if (done.length) {
            attachmentCache.delete(campaign.id);
            logger.info('Campaign completed', { campaignId: campaign.id });
        }
        return;
    }

    // Checked again here, not only at upload: they may have unsubscribed from
    // another campaign of the same customer since the list went in.
    const suppressed = await POSTGRESQLService.PostgresAny(
        `SELECT 1 FROM campaign_unsubscribes WHERE tenant_id = $1 AND email = $2`,
        [campaign.tenant_id, recipient.email]
    );
    if (suppressed.length) {
        await POSTGRESQLService.PostgresAny(
            `UPDATE campaign_recipients SET status = 'skipped', error = 'Unsubscribed' WHERE id = $1`,
            [recipient.id]
        );
        return;
    }

    let info;
    try {
        const files = await loadAttachments(campaign.id);
        const links = campaignLinks(recipient.token);
        const message = renderCampaign({
            campaign,
            data: { ...recipient.data, email: recipient.email },
            attachments: files,
            company: campaign.tenant_name,
            unsubscribeUrl: links.unsubscribe,
            pixelUrl: campaign.track_opens ? links.open : null
        });

        info = await mailer.sendMail(campaign.tenant_id, {
            to: [recipient.email],
            bulk: true,
            fromName: campaign.from_name || undefined,
            fromEmail: campaign.from_email || undefined,
            replyTo: campaign.reply_to || undefined,
            subject: message.subject,
            html: message.html,
            text: message.text,
            attachments: mailAttachments(files, message.html),
            // One-click unsubscribe (RFC 8058). Gmail and Yahoo require it from
            // bulk senders, and show their own Unsubscribe button next to the
            // sender name — which is pressed instead of "Report spam".
            headers: {
                'List-Unsubscribe': `<${links.unsubscribe}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
        });
    } catch (error) {
        await handleFailure(campaign, recipient, error);
        return;
    }

    await POSTGRESQLService.PostgresAny(
        `UPDATE campaign_recipients SET status = 'sent', sent_at = now(), message_id = $2, error = NULL WHERE id = $1`,
        [recipient.id, info.messageId]
    );
    await scheduleNext(campaign);
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        await POSTGRESQLService.PostgresAny(
            `UPDATE campaigns
                SET status = 'sending', started_at = COALESCE(started_at, now()), next_send_at = now(), updated_at = now()
              WHERE status = 'scheduled' AND scheduled_at <= now()`,
            []
        );

        const due = await POSTGRESQLService.PostgresAny(
            `SELECT c.*, t.name AS tenant_name, s.host AS smtp_host
               FROM campaigns c
               JOIN tenants t ON t.id = c.tenant_id
               LEFT JOIN tenant_smtp s ON s.tenant_id = c.tenant_id
              WHERE c.status = 'sending' AND (c.next_send_at IS NULL OR c.next_send_at <= now())
              ORDER BY c.next_send_at NULLS FIRST, c.id
              LIMIT 20`,
            []
        );

        // Campaigns run side by side — one slow message must not hold up
        // another customer's campaign — but each one sends strictly in order.
        for (const campaign of due) {
            if (inFlight.has(campaign.id)) continue;
            inFlight.add(campaign.id);
            sendNext(campaign)
                .catch((err) => logger.error('Campaign send step failed', {
                    campaignId: campaign.id, error: err.message, stack: err.stack
                }))
                .finally(() => inFlight.delete(campaign.id));
        }
    } catch (err) {
        logger.error('Campaign worker tick failed', { error: err.message });
    } finally {
        ticking = false;
    }
}

/**
 * Called once at boot, after migrations. A row still marked 'sending' means
 * the previous process died mid-send: it is marked failed with an honest
 * explanation rather than silently re-sent, because a duplicate in a client's
 * inbox is worse than a gap the operator can see and retry.
 */
async function start() {
    if (timer) return;
    const interrupted = await POSTGRESQLService.PostgresAny(
        `UPDATE campaign_recipients SET status = 'failed', error = $1 WHERE status = 'sending' RETURNING id`,
        [INTERRUPTED]
    );
    if (interrupted.length) logger.warn('Campaign messages interrupted by a restart', { count: interrupted.length });
    timer = setInterval(tick, TICK_MS);
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, tick, classify };
