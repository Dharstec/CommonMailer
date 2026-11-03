/**
 * Phone numbers the way WhatsApp wants them: digits only, country code first
 * (919840624198) — what Meta calls a wa_id.
 *
 * Lists come from visiting cards and spreadsheets, so a cell may read
 * "Mobile: +91 98406 24198", "098406-24198", "9840624198.0" (Excel made it a
 * number) or hold two numbers at once. The first one that can be a mobile wins.
 * Landlines cannot receive WhatsApp, so they are reported rather than kept.
 */

// A run of digits with the usual separators, long enough to be a number.
const CANDIDATE = /\+?\d[\d\s().-]{6,}\d/g;

/** In India ten digits starting 6–9 are a mobile; anything else is a landline. */
function indianMobile(digits) {
    if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
    if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
    if (/^91[6-9]\d{9}$/.test(digits)) return digits;
    return null;
}

function fromCandidate(candidate, defaultCountry) {
    const international = candidate.startsWith('+') || /^00/.test(candidate);
    const digits = candidate.replace(/\D/g, '').replace(/^00/, '');

    if (international || digits.startsWith(defaultCountry)) {
        if (digits.startsWith('91')) return indianMobile(digits);
        return digits.length >= 8 && digits.length <= 15 ? digits : null;
    }
    if (defaultCountry === '91') return indianMobile(digits);

    const national = digits.replace(/^0+/, '');
    const full = `${defaultCountry}${national}`;
    return national.length >= 6 && full.length <= 15 ? full : null;
}

/**
 * The candidate itself, then runs of its parts: "99860 88367 8028370099" is two
 * numbers only a space apart, and the first one is the mobile.
 */
function* pieces(candidate) {
    yield candidate;
    const tokens = candidate.split(/\s+/);
    for (let i = 0; i < tokens.length && tokens.length > 1; i += 1) {
        for (let j = i + 1; j <= Math.min(tokens.length, i + 4); j += 1) yield tokens.slice(i, j).join(' ');
    }
}

/**
 * @param {string} raw              the cell as it was in the list
 * @param {string} defaultCountry   added to numbers written without one ("91")
 * @returns {{ phone: string } | { reason: string }}
 */
function normalisePhone(raw, defaultCountry = '91') {
    const text = String(raw || '').replace(/(\d)\.0+(?!\d)/g, '$1');
    const candidates = text.match(CANDIDATE) || [];
    if (!candidates.length) return { reason: text.trim() ? 'Not a phone number' : 'Phone is empty' };

    for (const candidate of candidates) {
        for (const piece of pieces(candidate.trim())) {
            const phone = fromCandidate(piece, String(defaultCountry || '91'));
            if (phone) return { phone };
        }
    }
    return { reason: 'Not a mobile number — WhatsApp needs a mobile, not a landline' };
}

/** 919840624198 -> "+91 98406 24198" */
function formatPhone(phone) {
    const digits = String(phone || '');
    const india = /^91(\d{5})(\d{5})$/.exec(digits);
    return india ? `+91 ${india[1]} ${india[2]}` : `+${digits}`;
}

module.exports = { normalisePhone, formatPhone };
