/**
 * Sending hours. A campaign can be kept to, say, 10:00–18:00 Monday to
 * Saturday in its own time zone, so messages arrive while people are at work
 * rather than at 9 PM. Outside the hours the queue just waits for the next
 * opening; the daily limit and the gap still apply on top.
 *
 *   { start: '10:00', end: '18:00', days: [1, 2, 3, 4, 5, 6], tz: 'Asia/Kolkata' }
 *
 * days: 0 is Sunday. A campaign without a window sends at any time.
 */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function minutesOf(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
}

/** The wall clock in a time zone at one instant. */
function clockIn(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute'), ss: get('second') };
}

/** Minutes the zone is ahead of UTC at that instant (330 for India). */
function offsetAt(date, tz) {
    const c = clockIn(date, tz);
    return (Date.UTC(c.y, c.m - 1, c.d, c.hh, c.mm, c.ss) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

/** That day at that time on the zone's clock, as an instant. Twice round, for the days clocks change. */
function zoned(y, m, d, minutes, tz) {
    const naive = Date.UTC(y, m, d, 0, minutes);
    let utc = naive - offsetAt(new Date(naive), tz) * 60000;
    const again = naive - offsetAt(new Date(utc), tz) * 60000;
    if (again !== utc) utc = again;
    return new Date(utc);
}

/** The first moment at or after `from` that lies inside the window; `from` itself when there is none. */
function nextOpen(window, from = new Date()) {
    if (!window || !Array.isArray(window.days) || !window.days.length) return from;
    const start = minutesOf(window.start);
    const end = minutesOf(window.end);
    const days = new Set(window.days.map(Number));
    const today = clockIn(from, window.tz);

    for (let i = 0; i < 8; i += 1) {
        const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
        if (!days.has(day.getUTCDay())) continue;
        const y = day.getUTCFullYear();
        const m = day.getUTCMonth();
        const d = day.getUTCDate();
        const open = zoned(y, m, d, start, window.tz);
        if (from < open) return open;
        if (from < zoned(y, m, d, end, window.tz)) return from;
    }
    return from;
}

/** "Fri 6 Nov, 10:00" on the window's own clock. */
function formatAt(date, tz) {
    const c = clockIn(date, tz || 'Asia/Kolkata');
    const day = new Date(Date.UTC(c.y, c.m - 1, c.d));
    const month = day.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
    return `${DAY_NAMES[day.getUTCDay()]} ${c.d} ${month}, ${String(c.hh).padStart(2, '0')}:${String(c.mm).padStart(2, '0')}`;
}

/** "10:00–18:00, Mon–Sat" */
function describe(window) {
    if (!window) return 'any time';
    const days = [...new Set(window.days.map(Number))].sort();
    const run = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    const which = days.length === 7 ? 'every day' : run ? `${DAY_NAMES[days[0]]}–${DAY_NAMES[days[days.length - 1]]}` : days.map((d) => DAY_NAMES[d]).join(', ');
    return `${window.start}–${window.end}, ${which}`;
}

function validZone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch (error) {
        return false;
    }
}

module.exports = { nextOpen, describe, formatAt, validZone, minutesOf };
