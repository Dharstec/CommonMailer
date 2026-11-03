/**
 * Background sender for WhatsApp campaigns — the email sender's twin
 * (helpers/campaignWorker.js), with the number's own pace:
 *
 *   WHATSAPP_GAP_MINUTES   at least this long between two messages   (default 2)
 *   WHATSAPP_DAILY_LIMIT   at most this many a day (CAMPAIGN_TIMEZONE)  (default 20)
 *
 * A number's quality rating is what Meta judges it by: people who block or
 * report a business lower it, and a Low rating gets the number limited. So the
 * pace starts slow, the rating is checked while sending, and a Low rating
 * pauses everything until someone has looked.
 */
const POSTGRESQLService = require('./POSTGRES');
const whatsapp = require('./whatsapp');
const { createPace, setting } = require('./campaignPace');
const sendWindow = require('./sendWindow');
const logger = require('./logger');

const pace = createPace({
    paceTable: 'wa_pace',
    logTable: 'wa_send_log',
    noun: 'message',
    gapSeconds: Math.max(1, Math.round(setting(process.env.WHATSAPP_GAP_MINUTES, 2) * 60)),
    dailyLimit: Math.max(1, Math.floor(setting(process.env.WHATSAPP_DAILY_LIMIT, 20)))
});

const TICK_MS = 1000;
const BACKOFF_MINUTES = [5, 10, 15, 30, 60];
const FAILURE_STREAK_LIMIT = 3;
/** How stale the number's quality rating may get before it is asked again. */
const QUALITY_CHECK_MINUTES = 30;

const INTERRUPTED = 'The server restarted while this message was being sent, so it may or may not have '
    + 'been delivered. Retry it only if you are sure it did not arrive.';

let timer = null;
let ticking = false;
// Customers with a message on its way: one at a time per number.
const inFlight = new Set();

async function pause(campaignId, reason) {
    await POSTGRESQLService.PostgresAny(
        `UPDATE wa_campaigns
            SET status = 'paused', status_reason = $2, next_send_at = NULL, retry_count = 0, updated_at = now()
          WHERE id = $1 AND status = 'sending'`,
        [campaignId, reason]
    );
    logger.warn('WhatsApp campaign paused automatically', { campaignId, reason });
}

/** This campaign's next turn: so many seconds from now, moved into its sending hours. */
function turnAfter(campaign, seconds) {
    return sendWindow.nextOpen(campaign.send_window, new Date(Date.now() + seconds * 1000));
}

async function scheduleNext(campaign) {
    await POSTGRESQLService.PostgresAny(
        `UPDATE wa_campaigns
            SET next_send_at = $2, retry_count = 0, status_reason = NULL
          WHERE id = $1 AND status = 'sending'`,
        [campaign.id, turnAfter(campaign, pace.GAP_SECONDS)]
    );
}

async function waitForNumber(campaign) {
    const rows = await POSTGRESQLService.PostgresAny(`SELECT next_send_at FROM wa_pace WHERE tenant_id = $1`, [campaign.tenant_id]);
    if (!rows.length) return;
    await POSTGRESQLService.PostgresAny(
        `UPDATE wa_campaigns SET next_send_at = $2 WHERE id = $1 AND status = 'sending'`,
        [campaign.id, sendWindow.nextOpen(campaign.send_window, new Date(rows[0].next_send_at))]
    );
}

/** A Low (red) quality rating stops the campaign before it can get worse. */
async function qualityAllows(campaign, account) {
    const fresh = account.checked_at && Date.now() - new Date(account.checked_at).getTime() < QUALITY_CHECK_MINUTES * 60000;
    let rating = account.quality_rating;
    if (!fresh) {
        try {
            rating = (await whatsapp.checkNumber(account)).quality_rating;
        } catch (error) {
            logger.warn('WhatsApp quality check failed', { tenantId: account.tenant_id, error: error.message });
        }
    }
    if (rating !== 'RED') return true;
    await pause(campaign.id, 'WhatsApp rates this number\'s quality as Low — too many people blocked or reported '
        + 'its messages. Sending was paused so it does not get limited. Wait a few days, check the template and the '
        + 'list, then resume.');
    return false;
}

async function handleFailure(campaign, recipient, error) {
    const kind = whatsapp.classify(error);
    const reason = whatsapp.explain(error);
    logger.warn('WhatsApp message failed', { campaignId: campaign.id, to: recipient.phone, kind, code: error.code, error: error.message });

    if (kind === 'recipient') {
        await POSTGRESQLService.PostgresAny(
            `UPDATE wa_recipients SET status = 'failed', error = $2 WHERE id = $1`, [recipient.id, reason]
        );
        // They told WhatsApp to stop marketing from this business: never again, from any campaign.
        if (error.code === 131050) {
            await POSTGRESQLService.PostgresAny(
                `INSERT INTO wa_optouts (tenant_id, phone, source, campaign_id) VALUES ($1, $2, 'button', $3)
                 ON CONFLICT (tenant_id, phone) DO NOTHING`,
                [campaign.tenant_id, recipient.phone, campaign.id]
            );
        }
        const recent = await POSTGRESQLService.PostgresAny(
            `SELECT status FROM wa_recipients
              WHERE campaign_id = $1 AND attempted_at IS NOT NULL AND status <> 'pending'
              ORDER BY attempted_at DESC LIMIT $2`,
            [campaign.id, FAILURE_STREAK_LIMIT]
        );
        if (recent.length === FAILURE_STREAK_LIMIT && recent.every((r) => r.status === 'failed')) {
            await pause(campaign.id, `The last ${FAILURE_STREAK_LIMIT} messages all failed, so sending was paused to `
                + 'protect your number. Check the errors in the report before resuming.');
        } else {
            await scheduleNext(campaign);
        }
        return;
    }

    await POSTGRESQLService.PostgresAny(
        `UPDATE wa_recipients SET status = 'pending', attempted_at = NULL WHERE id = $1`, [recipient.id]
    );
    if (kind === 'temporary' && campaign.retry_count < BACKOFF_MINUTES.length) {
        const seconds = Math.max(BACKOFF_MINUTES[campaign.retry_count] * 60, pace.GAP_SECONDS);
        await POSTGRESQLService.PostgresAny(
            `UPDATE wa_campaigns
                SET retry_count = retry_count + 1,
                    next_send_at = $2,
                    status_reason = $3
              WHERE id = $1 AND status = 'sending'`,
            [campaign.id, turnAfter(campaign, seconds), `${reason} Retrying automatically.`]
        );
        return;
    }
    await pause(campaign.id, reason);
}

async function sendNext(campaign) {
    if (!await pace.claim(campaign.tenant_id)) {
        await waitForNumber(campaign);
        return;
    }
    const rest = await sendOne(campaign);
    await pace.release(campaign.tenant_id, rest);
}

/** Sends the next message of the queue. Returns how many seconds the number rests afterwards. */
async function sendOne(campaign) {
    const done = await POSTGRESQLService.PostgresAny(
        `UPDATE wa_campaigns
            SET status = 'completed', completed_at = now(), next_send_at = NULL, status_reason = NULL, updated_at = now()
          WHERE id = $1 AND status = 'sending'
            AND NOT EXISTS (SELECT 1 FROM wa_recipients WHERE campaign_id = $1 AND status IN ('pending', 'sending'))
        RETURNING id`,
        [campaign.id]
    );
    if (done.length) {
        logger.info('WhatsApp campaign completed', { campaignId: campaign.id });
        return 0;
    }

    const account = await whatsapp.accountOf(campaign.tenant_id);
    if (!account) {
        await pause(campaign.id, 'This customer has no WhatsApp number connected any more. Connect it in WhatsApp setup.');
        return 0;
    }

    // Outside its sending hours: wait for the next opening, without using up a turn.
    const opens = sendWindow.nextOpen(campaign.send_window);
    if (opens.getTime() > Date.now() + 1000) {
        await POSTGRESQLService.PostgresAny(`UPDATE wa_campaigns SET next_send_at = $2 WHERE id = $1 AND status = 'sending'`, [campaign.id, opens]);
        return 0;
    }

    const wait = await pace.dailyWait(campaign.tenant_id);
    if (wait) {
        await POSTGRESQLService.PostgresAny(
            `UPDATE wa_campaigns SET next_send_at = $2 WHERE id = $1 AND status = 'sending'`,
            [campaign.id, turnAfter(campaign, wait)]
        );
        // The number's slot is not held for this: the count is read afresh every
        // turn, so tomorrow — or a change of rule — needs nothing undone.
        return 0;
    }
    if (!await qualityAllows(campaign, account)) return 0;

    const claimed = await POSTGRESQLService.PostgresAny(
        `UPDATE wa_recipients SET status = 'sending', attempted_at = now()
          WHERE id = (
              SELECT r.id FROM wa_recipients r
               WHERE r.campaign_id = $1 AND r.status = 'pending'
                 AND EXISTS (SELECT 1 FROM wa_campaigns c WHERE c.id = $1 AND c.status = 'sending')
               ORDER BY r.id
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
        RETURNING *`,
        [campaign.id]
    );
    const recipient = claimed[0];
    if (!recipient) return 0;

    const optedOut = await POSTGRESQLService.PostgresAny(
        `SELECT 1 FROM wa_optouts WHERE tenant_id = $1 AND phone = $2`, [campaign.tenant_id, recipient.phone]
    );
    if (optedOut.length) {
        await POSTGRESQLService.PostgresAny(
            `UPDATE wa_recipients SET status = 'skipped', error = 'Asked not to be messaged' WHERE id = $1`, [recipient.id]
        );
        return 0;
    }

    const { components, missing } = whatsapp.buildComponents(campaign, { ...recipient.data, phone: recipient.phone });
    if (missing.length) {
        await POSTGRESQLService.PostgresAny(
            `UPDATE wa_recipients SET status = 'failed', error = $2 WHERE id = $1`,
            [recipient.id, `Nothing to fill ${missing.join(', ')} with for this contact. Give it a fallback in step 2.`]
        );
        return 0;
    }

    await pace.record(campaign.tenant_id, campaign.id);

    let messageId;
    try {
        messageId = await whatsapp.sendTemplate(account, recipient.phone, {
            name: campaign.template_name,
            language: campaign.template_language,
            components
        });
    } catch (error) {
        await handleFailure(campaign, recipient, error);
        return pace.GAP_SECONDS;
    }

    // A status webhook may already have moved it on (delivered, read) — never step back.
    await POSTGRESQLService.PostgresAny(
        `UPDATE wa_recipients SET status = 'sent', sent_at = now(), wa_message_id = $2, error = NULL
          WHERE id = $1 AND status = 'sending'`,
        [recipient.id, messageId || null]
    );
    await scheduleNext(campaign);
    return pace.GAP_SECONDS;
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        await POSTGRESQLService.PostgresAny(
            `UPDATE wa_campaigns
                SET status = 'sending', started_at = COALESCE(started_at, now()), next_send_at = now(), updated_at = now()
              WHERE status = 'scheduled' AND scheduled_at <= now()`,
            []
        );

        const due = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM wa_campaigns
              WHERE status = 'sending' AND (next_send_at IS NULL OR next_send_at <= now())
              ORDER BY next_send_at NULLS FIRST, id
              LIMIT 20`,
            []
        );
        for (const campaign of due) {
            if (inFlight.has(campaign.tenant_id)) continue;
            inFlight.add(campaign.tenant_id);
            sendNext(campaign)
                .catch((err) => logger.error('WhatsApp send step failed', {
                    campaignId: campaign.id, error: err.message, stack: err.stack
                }))
                .finally(() => inFlight.delete(campaign.tenant_id));
        }
    } catch (err) {
        logger.error('WhatsApp worker tick failed', { error: err.message });
    } finally {
        ticking = false;
    }
}

/** Called once at boot, after migrations — same honesty about interrupted sends as the email sender. */
async function start() {
    if (timer) return;
    const interrupted = await POSTGRESQLService.PostgresAny(
        `UPDATE wa_recipients SET status = 'failed', error = $1 WHERE status = 'sending' RETURNING id`,
        [INTERRUPTED]
    );
    if (interrupted.length) logger.warn('WhatsApp messages interrupted by a restart', { count: interrupted.length });
    // A slot held for longer than one gap is left over from an older rule (the
    // daily limit used to hold it until the next day): nothing is in flight at
    // boot, so one gap from now is all it may still ask for.
    await POSTGRESQLService.PostgresAny(
        `UPDATE wa_pace SET next_send_at = now() + make_interval(secs => $1::double precision), updated_at = now()
          WHERE next_send_at > now() + make_interval(secs => $1::double precision)`,
        [pace.GAP_SECONDS]
    );
    // The rules for the next turn may have changed with this version (pace, hours):
    // a campaign that is only waiting works its next turn out again at once. The
    // gap and the daily limit are checked as always; retries keep their back-off.
    await POSTGRESQLService.PostgresAny(
        `UPDATE wa_campaigns SET next_send_at = now() WHERE status = 'sending' AND retry_count = 0 AND next_send_at > now()`, []
    );
    timer = setInterval(tick, TICK_MS);
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, tick, pace };
