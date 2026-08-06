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
const POSTGRESQLService = require('./POSTGRES');
const { decrypt } = require('./crypto');
const logger = require('./logger');

/**
 * Compares an incoming Origin against the form's allowlist.
 *
 * A missing Origin is allowed: that is a server-to-server or curl call, which
 * the browser-oriented CORS model does not cover and which the rate limiter and
 * validation still gate. A *present but unlisted* Origin is a real browser on a
 * site we did not authorise, so it is rejected.
 */
function checkOrigin(origin, allowedOrigins) {
    if (!origin) return null;

    const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
    if (list.length === 0) return 'origin_not_configured';

    const normalise = (u) => String(u).trim().replace(/\/+$/, '').toLowerCase();
    const incoming = normalise(origin);

    const allowed = list.some((entry) => {
        const candidate = normalise(entry);
        if (candidate === '*') return true;
        if (candidate === incoming) return true;
        // "*.example.com" covers any subdomain but not a lookalike suffix.
        if (candidate.startsWith('*.')) {
            const suffix = candidate.slice(1); // ".example.com"
            try {
                const host = new URL(incoming).host;
                return host.endsWith(suffix.slice(1)) || host === suffix.slice(2);
            } catch (err) {
                return false;
            }
        }
        return false;
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
    checkRecaptcha,
    clientIp
};
