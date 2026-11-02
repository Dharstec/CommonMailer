/**
 * How fast campaigns may send from a mailbox.
 *
 * The pace belongs to the customer's mailbox, not to a campaign. Inbox
 * providers judge a sender by everything it sends, and a young domain that
 * suddenly sends a lot looks exactly like a spammer — so every campaign of one
 * customer shares one slot (campaign_pace) and one daily count
 * (campaign_send_log), and the numbers are set on the server, not in the panel:
 *
 *   CAMPAIGN_GAP_MINUTES   at least this long between two emails    (default 5)
 *   CAMPAIGN_DAILY_LIMIT   at most this many in any 24 hours        (default 10)
 *
 * Every email handed to the mail server counts, whatever it answered. Whatever
 * the limit leaves over waits in the queue and goes out on the following days.
 */
const POSTGRESQLService = require('./POSTGRES');

function setting(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const GAP_SECONDS = Math.max(1, Math.round(setting(process.env.CAMPAIGN_GAP_MINUTES, 5) * 60));
const DAILY_LIMIT = Math.max(1, Math.floor(setting(process.env.CAMPAIGN_DAILY_LIMIT, 10)));

/** Longer than any one message can take. A slot held by a process that died frees itself after this. */
const HOLD = '30 minutes';

/**
 * Takes the mailbox's slot if it is due. False means not yet: the gap after the
 * last email has not passed, or the daily limit holds it.
 */
async function claim(tenantId) {
    const rows = await POSTGRESQLService.PostgresAny(
        `INSERT INTO campaign_pace AS p (tenant_id, next_send_at) VALUES ($1, now() + interval '${HOLD}')
         ON CONFLICT (tenant_id) DO UPDATE SET next_send_at = EXCLUDED.next_send_at, updated_at = now()
          WHERE p.next_send_at <= now()
         RETURNING tenant_id`,
        [tenantId]
    );
    return rows.length > 0;
}

/** Hands the slot back: the next email may go out this many seconds from now. */
async function release(tenantId, seconds) {
    await POSTGRESQLService.PostgresAny(
        `UPDATE campaign_pace
            SET next_send_at = now() + make_interval(secs => $2::double precision), updated_at = now()
          WHERE tenant_id = $1`,
        [tenantId, seconds]
    );
}

/** Counts one email towards the mailbox's day — before it leaves, so a crash mid-send still counts. */
async function record(tenantId, campaignId) {
    await POSTGRESQLService.PostgresAny(
        `INSERT INTO campaign_send_log (tenant_id, campaign_id) VALUES ($1, $2)`,
        [tenantId, campaignId]
    );
}

/**
 * Seconds until the mailbox is under its daily limit again; 0 when it is
 * already. Over a rolling 24 hours, so no two calendar days can be stacked
 * back to back: the window frees up once its DAILY_LIMIT-th newest email is a
 * day old.
 */
async function dailyWait(tenantId) {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT extract(epoch FROM attempted_at + interval '24 hours 5 seconds' - now()) AS wait
           FROM (SELECT attempted_at, row_number() OVER (ORDER BY attempted_at DESC) AS newest
                   FROM campaign_send_log
                  WHERE tenant_id = $1 AND attempted_at > now() - interval '24 hours') w
          WHERE newest = $2`,
        [tenantId, DAILY_LIMIT]
    );
    return rows.length ? Math.max(1, Number(rows[0].wait)) : 0;
}

/** For the panel: the limits, and how much of the last 24 hours the mailbox has used. */
async function status(tenantId) {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT count(*)::int AS used FROM campaign_send_log
          WHERE tenant_id = $1 AND attempted_at > now() - interval '24 hours'`,
        [tenantId]
    );
    return { gap_minutes: GAP_SECONDS / 60, daily_limit: DAILY_LIMIT, last_24h: rows[0].used };
}

/** "one email every 5 minutes, at most 10 a day" */
function describe() {
    const minutes = GAP_SECONDS / 60;
    const gap = minutes >= 1
        ? `${Number(minutes.toFixed(1))} minute${minutes === 1 ? '' : 's'}`
        : `${GAP_SECONDS} seconds`;
    return `one email every ${gap}, at most ${DAILY_LIMIT} a day`;
}

module.exports = { GAP_SECONDS, DAILY_LIMIT, claim, release, record, dailyWait, status, describe };
