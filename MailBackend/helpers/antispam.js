/**
 * Layered abuse checks for the public submit endpoint.
 *
 * No single check is reliable on its own: honeypots miss targeted bots, captcha
 * scores are probabilistic, origin headers are absent on server-to-server calls.
 * Stacking cheap checks first (origin, honeypot, timing) means the expensive
 * ones (DB rate-limit count, Google round-trip) only run for plausible traffic.
 *
 * Every function returns null when the request is fine, or a short reason string
 * when it should be rejected. Reasons are logged and stored, never returned to
 * the visitor — telling a bot which check caught it is free tuning feedback.
 */
const axios = require('axios');
const crypto = require('crypto');
const POSTGRESQLService = require('./POSTGRES');
const { decrypt } = require('./crypto');
const logger = require('./logger');

/**
 * Compares an incoming Origin against the form's allowlist.
 *
 * A *present but unlisted* Origin is a real browser on a site we did not
 * authorise, so it is rejected.
 *
 * A *missing* Origin used to be an automatic pass, on the reasoning that
 * server-to-server callers have no Origin and the later layers still gate them.
 * They do not: the honeypot, the timing token and the captcha response all
 * originate in the page, so a caller that never loads the page skips all three
 * by simply omitting them, and only the per-IP rate limit is left — which a bot
 * rotating addresses never reaches. That is the whole of how a direct-POST spam
 * run gets in.
 *
 * Browsers send Origin on every POST, cross-origin and same-origin alike (Fetch
 * spec, "same-origin" request with a method other than GET/HEAD), so on a form
 * that is only ever submitted from a web page, absent means "not a browser".
 * `requireOrigin` is per-form because a form genuinely called from someone's
 * backend must still be able to opt out.
 */
function checkOrigin(origin, allowedOrigins, requireOrigin) {
    if (!origin) return requireOrigin ? 'origin_missing' : null;

    const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
    if (list.length === 0) return 'origin_not_configured';

    const normalise = (u) => String(u).trim().replace(/\/+$/, '').toLowerCase();
    const incoming = normalise(origin);

    const allowed = list.some((entry) => {
        const candidate = normalise(entry);
        if (candidate === '*') return true;
        if (candidate === incoming) return true;

        // "https://*.example.com" covers any subdomain and the apex, but not a
        // lookalike suffix: notexample.com must not match .example.com.
        //
        // The wildcard sits after the scheme, because that is the only shape
        // the admin schema accepts (originList in helpers/validator.js) and the
        // only one the panel tells you to write. An earlier version tested for a
        // leading "*." instead, which no accepted entry ever has, so wildcard
        // entries silently matched nothing at all.
        const [scheme, pattern] = candidate.split('://');
        if (!pattern || !pattern.startsWith('*.')) return false;

        const suffix = pattern.slice(1); // ".example.com"
        try {
            const url = new URL(incoming);
            if (url.protocol.replace(/:$/, '') !== scheme) return false;
            return url.host.endsWith(suffix) || url.host === suffix.slice(1);
        } catch (err) {
            return false;
        }
    });

    return allowed ? null : 'origin_not_allowed';
}

/** A hidden field only an automated filler would populate. */
function checkHoneypot(body, honeypotField) {
    if (!honeypotField) return null;
    const value = body[honeypotField];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
        return 'honeypot_filled';
    }
    return null;
}

/**
 * Optional "too fast to be a human" check.
 *
 * You write the customer's HTML yourself, so `_ts` is opt-in: stamp the page
 * load time into a hidden input and this fires, leave it out and the check is
 * simply skipped. A *missing* `_ts` is therefore not suspicious — only a present
 * one that says the form was filled in impossibly fast.
 */
function checkTiming(body, minSeconds) {
    if (!minSeconds || minSeconds <= 0) return null;
    if (body._ts === undefined || body._ts === null || body._ts === '') return null;

    const started = Number(body._ts);
    if (!started || Number.isNaN(started)) return null;

    const elapsedSeconds = (Date.now() - started) / 1000;
    if (elapsedSeconds < minSeconds) return 'timing_too_fast';
    // A token older than 12 hours is a replayed page, not a live visitor.
    if (elapsedSeconds > 43200) return 'timing_expired';

    return null;
}

/**
 * Per-form, per-IP throttle counted from the submissions table, so it survives
 * restarts and applies across every node behind a load balancer — unlike the
 * in-memory express-rate-limit, which is the coarse global net in app.js.
 */
async function checkRateLimit(formId, ip, maxPerHour) {
    if (!maxPerHour || maxPerHour <= 0) return null;
    if (!ip) return null;

    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT count(*)::int AS total
           FROM submissions
          WHERE form_id = $1 AND ip = $2 AND created_at > now() - interval '1 hour'`,
        [formId, ip]
    );

    return rows[0] && rows[0].total >= maxPerHour ? 'rate_limited' : null;
}

/**
 * Stable fingerprint of the submitted values.
 *
 * Keys are sorted so two payloads that differ only in property order hash
 * alike, and values are lower-cased and whitespace-collapsed so a retry that
 * re-serialises the form does not read as a different message.
 */
function payloadHash(data) {
    const normalise = (value) => {
        if (Array.isArray(value)) return value.map(normalise);
        if (value === null || value === undefined) return '';
        return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
    };

    const canonical = Object.keys(data || {})
        .sort()
        .map((key) => [key, normalise(data[key])]);

    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Drops an identical payload replayed inside the window.
 *
 * Deliberately keyed on the payload and not the IP: the spam run that prompted
 * this sent each message twice from the same address about 3.5 seconds apart,
 * but the same retry loop behind rotating addresses would otherwise still land
 * twice. It also absorbs the human version of the same thing — a double-click
 * on Send, or a page restored from the back/forward cache.
 */
async function checkDuplicate(formId, hash, windowMinutes) {
    if (!windowMinutes || windowMinutes <= 0) return null;
    if (!hash) return null;

    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT 1
           FROM submissions
          WHERE form_id = $1
            AND payload_hash = $2
            AND created_at > now() - ($3 || ' minutes')::interval
          LIMIT 1`,
        [formId, hash, String(windowMinutes)]
    );

    return rows.length ? 'duplicate_submission' : null;
}

/**
 * Does one whitespace-delimited token look machine-generated?
 *
 * Three cheap signals, two of which must fire. Any one alone has real
 * false positives — a long acronym, a German compound, a password pasted into
 * the wrong box — so no single one is trusted.
 */
function tokenLooksRandom(token) {
    const letters = token.replace(/[^A-Za-z]/g, '');
    if (letters.length < 8) return false;

    let signals = 0;

    // Vowel ratio. Running text sits around 35-45%; a base62 string drifts far
    // below, keyboard mashing sometimes far above.
    const vowels = (letters.match(/[aeiou]/gi) || []).length;
    const ratio = vowels / letters.length;
    if (ratio < 0.26 || ratio > 0.66) signals += 1;

    // Consonant runs. No natural language stacks five in one syllable.
    if (/[^aeiou]{5,}/i.test(letters)) signals += 1;

    // Case churn. Real words are lower, Title or UPPER; a random string flips
    // every few characters.
    if ((letters.match(/[a-z][A-Z]|[A-Z][a-z]/g) || []).length >= 3) signals += 1;

    return signals >= 2;
}

/**
 * URLs, email addresses and file paths are legitimately unpronounceable —
 * "https://www.example.com/my-itinerary.pdf" trips every signal above — and a
 * visitor pasting one is the opposite of suspicious. Exclude them before
 * scoring rather than trying to score them.
 */
const OPAQUE_TOKEN = /(:\/\/|@|^www\.|\.[a-z]{2,}\/)/i;

/** Does one field's value read as random characters rather than a message? */
function valueLooksRandom(value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (text.length < 12) return false;

    const tokens = text.split(/\s+/).filter((t) => !OPAQUE_TOKEN.test(t));
    if (tokens.length === 0) return false;

    // A single unbroken blob is the classic filler — "dpzuDpOBLOdlervZvhwuJlQ".
    if (tokens.length === 1) return tokenLooksRandom(tokens[0]);

    // Otherwise judge only words long enough to judge, and require most of them
    // to be soup, so one odd token in a real sentence never trips it.
    const long = tokens.filter((t) => t.replace(/[^A-Za-z]/g, '').length >= 8);
    if (long.length === 0) return false;
    const random = long.filter(tokenLooksRandom).length;
    return random >= Math.max(2, Math.ceil(long.length * 0.6));
}

/**
 * Opt-in content heuristic over the form's free-text fields.
 *
 * This is the only check in this file that can be wrong about a real person, so
 * it is off unless a form turns it on, it looks at free text only — never at a
 * name, email or phone, where short and unusual values are normal — and a hit
 * is stored rather than discarded so the admin panel shows what it caught.
 */
function checkContent(data, fields, enabled) {
    if (!enabled) return null;

    const freeText = (Array.isArray(fields) ? fields : [])
        .filter((f) => f.field_type === 'textarea' || f.field_type === 'text');

    for (const field of freeText) {
        if (valueLooksRandom(data[field.field_key])) return 'content_random_text';
    }

    return null;
}

/** Google reCAPTCHA v3: verify the token and require a minimum score. */
async function checkRecaptcha(form, token, ip) {
    if (!form.recaptcha_enabled) return null;
    if (!form.recaptcha_secret_enc) return 'captcha_not_configured';
    if (!token) return 'captcha_missing';

    let secret;
    try {
        secret = decrypt(form.recaptcha_secret_enc);
    } catch (err) {
        logger.error('reCAPTCHA secret could not be decrypted', { formId: form.id, error: err.message });
        return 'captcha_not_configured';
    }

    try {
        const params = new URLSearchParams({ secret, response: token });
        if (ip) params.append('remoteip', ip);

        const { data } = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
        );

        if (!data.success) return 'captcha_failed';
        if (typeof data.score === 'number' && data.score < Number(form.recaptcha_min_score)) {
            return 'captcha_low_score';
        }
        return null;
    } catch (err) {
        // Google being unreachable must not take the customer's contact form
        // down — the other layers still apply.
        logger.warn('reCAPTCHA verify unreachable, allowing through', { error: err.message });
        return null;
    }
}

/**
 * Trusts the left-most X-Forwarded-For entry only when Express itself is
 * configured to trust the proxy; otherwise req.ip already holds the socket
 * address. Never read the header directly — it is visitor-controlled.
 */
function clientIp(req) {
    return (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
}

module.exports = {
    checkOrigin,
    checkHoneypot,
    checkTiming,
    checkRateLimit,
    checkDuplicate,
    checkContent,
    checkRecaptcha,
    payloadHash,
    clientIp,
    // exported for the unit tests only
    valueLooksRandom
};
