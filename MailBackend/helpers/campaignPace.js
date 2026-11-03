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
 *   CAMPAIGN_DAILY_LIMIT   at most this many a day                  (default 10)
 *   CAMPAIGN_TIMEZONE      whose calendar "a day" is      (default Asia/Kolkata)
 *
 * A day is a calendar day on that clock, midnight to midnight — what people
 * mean by "10 a day": yesterday evening's emails do not hold back this
 * morning's. Every email handed to the mail server counts, whatever it
 * answered. Whatever the limit leaves over waits in the queue and goes out on
 * the following days.
 *
 * WhatsApp campaigns get the same machinery with their own tables and numbers
 * (helpers/whatsappWorker.js), through createPace().
 */
const POSTGRESQLService = require('./POSTGRES');
const { validZone } = require('./sendWindow');

function setting(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Longer than any one message can take. A slot held by a process that died frees itself after this. */
const HOLD = '30 minutes';

const DAY_ZONE = validZone(process.env.CAMPAIGN_TIMEZONE || '') ? process.env.CAMPAIGN_TIMEZONE : 'Asia/Kolkata';

/** Midnight today and tomorrow on DAY_ZONE's calendar, as SQL (the zone is $2). */
const TODAY = `(date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`;
const TOMORROW = `((date_trunc('day', now() AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2)`;

/**
 * One channel's pace. The table names are fixed strings from this codebase,
 * never input, which is why they can sit in the SQL.
 */
function createPace({ paceTable, logTable, gapSeconds, dailyLimit, noun }) {
    /**
     * Takes the sender's slot if it is due. False means not yet: the gap after
     * the last message has not passed, or the daily limit holds it.
     */
    async function claim(tenantId) {
        const rows = await POSTGRESQLService.PostgresAny(
            `INSERT INTO ${paceTable} AS p (tenant_id, next_send_at) VALUES ($1, now() + interval '${HOLD}')
             ON CONFLICT (tenant_id) DO UPDATE SET next_send_at = EXCLUDED.next_send_at, updated_at = now()
              WHERE p.next_send_at <= now()
             RETURNING tenant_id`,
            [tenantId]
        );
        return rows.length > 0;
    }

    /** Hands the slot back: the next message may go out this many seconds from now. */
    async function release(tenantId, seconds) {
        await POSTGRESQLService.PostgresAny(
            `UPDATE ${paceTable}
                SET next_send_at = now() + make_interval(secs => $2::double precision), updated_at = now()
              WHERE tenant_id = $1`,
            [tenantId, seconds]
        );
    }

    /** Counts one message towards the day — before it leaves, so a crash mid-send still counts. */
    async function record(tenantId, campaignId) {
        await POSTGRESQLService.PostgresAny(
            `INSERT INTO ${logTable} (tenant_id, campaign_id) VALUES ($1, $2)`,
            [tenantId, campaignId]
        );
    }

    /** Messages so far today, and the seconds to the next midnight. */
    async function today(tenantId) {
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT count(*)::int AS used,
                    extract(epoch FROM ${TOMORROW} - now()) + 5 AS until_tomorrow
               FROM ${logTable}
              WHERE tenant_id = $1 AND attempted_at >= ${TODAY}`,
            [tenantId, DAY_ZONE]
        );
        return { used: rows[0].used, untilTomorrow: Number(rows[0].until_tomorrow) };
    }

    /** Seconds until tomorrow once today's share is used up; 0 while some is left. */
    async function dailyWait(tenantId) {
        const { used, untilTomorrow } = await today(tenantId);
        return used >= dailyLimit ? Math.max(1, untilTomorrow) : 0;
    }

    /** For the panel: the limits, and how much of today the sender has used. */
    async function status(tenantId) {
        const { used } = await today(tenantId);
        return { gap_minutes: gapSeconds / 60, daily_limit: dailyLimit, today: used };
    }

    /** "one email every 5 minutes, at most 10 a day" */
    function describe() {
        const minutes = gapSeconds / 60;
        const gap = minutes >= 1
            ? `${Number(minutes.toFixed(1))} minute${minutes === 1 ? '' : 's'}`
            : `${gapSeconds} seconds`;
        return `one ${noun} every ${gap}, at most ${dailyLimit} a day`;
    }

    return { GAP_SECONDS: gapSeconds, DAILY_LIMIT: dailyLimit, claim, release, record, dailyWait, status, describe };
}

const email = createPace({
    paceTable: 'campaign_pace',
    logTable: 'campaign_send_log',
    noun: 'email',
    gapSeconds: Math.max(1, Math.round(setting(process.env.CAMPAIGN_GAP_MINUTES, 5) * 60)),
    dailyLimit: Math.max(1, Math.floor(setting(process.env.CAMPAIGN_DAILY_LIMIT, 10)))
});

module.exports = { ...email, createPace, setting };
