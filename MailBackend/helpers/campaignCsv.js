/**
 * Turns an uploaded recipient list into rows a campaign can send to.
 *
 * Built for what people actually export, not for a tidy spec:
 *   - Excel "CSV UTF-8" (has a BOM), plain "CSV" (Windows-1252) and
 *     "Unicode Text" (UTF-16, tab separated)
 *   - comma, semicolon (European Excel) or tab separators
 *   - quoted cells with commas and line breaks inside them
 *   - headers as people write them: "Email ID", "E-mail", "Company Name"
 *   - a bare list of addresses with no header row at all
 *
 * Every column becomes a {{merge_field}}. Nothing here touches the database;
 * the caller decides what to do with addresses that have unsubscribed.
 */
const Joi = require('joi');

const MAX_ROWS = 20000;
const MAX_REPORTED_INVALID = 200;

const emailRule = Joi.string().email({ tlds: { allow: false } }).max(254).required();

/**
 * Header spellings that mean the same thing. The canonical key is added next
 * to the original, so a sheet with "Company Name" answers to both
 * {{company_name}} and {{company}}.
 */
const ALIASES = {
    email: ['email', 'e_mail', 'email_address', 'e_mail_address', 'email_id', 'emailid', 'email_ids',
        'mail', 'mail_id', 'mailid'],
    name: ['name', 'full_name', 'fullname', 'contact_name', 'contact_person', 'person_name'],
    first_name: ['first_name', 'firstname', 'fname', 'given_name'],
    last_name: ['last_name', 'lastname', 'lname', 'surname', 'family_name'],
    company: ['company', 'company_name', 'companyname', 'organization', 'organisation',
        'organization_name', 'organisation_name', 'org', 'business', 'business_name', 'firm']
};

/**
 * Misspelt domains that would bounce. A bounce costs sender reputation, so the
 * row is held back with a suggestion rather than silently "corrected" — the
 * person who owns the list should decide.
 */
const DOMAIN_TYPOS = {
    'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gamil.com': 'gmail.com',
    'gnail.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com',
    'gmail.in': 'gmail.com', 'gmail.om': 'gmail.com',
    'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahho.com': 'yahoo.com', 'yahoo.co': 'yahoo.com',
    'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmil.com': 'hotmail.com',
    'outlok.com': 'outlook.com', 'outllook.com': 'outlook.com', 'outlook.co': 'outlook.com',
    'redifmail.com': 'rediffmail.com', 'rediffmai.com': 'rediffmail.com', 'rediffmial.com': 'rediffmail.com'
};
const TLD_TYPO = /\.(con|cmo|ocm|vom|xom|comm|coom)$/;

/** Courtesy titles that are not a first name: "Dr. Priya Raman" greets Priya. */
const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|shri|smt|sri|thiru|thirumathi|er|adv)\.?$/i;

function decode(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(buffer.subarray(2));
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(buffer.subarray(2));
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
    } catch (err) {
        // Not valid UTF-8: Excel's plain "CSV" on Windows writes Windows-1252.
        return new TextDecoder('windows-1252').decode(buffer);
    }
}

/** Picks the separator that occurs most often, outside quotes, on the first line. */
function detectDelimiter(text) {
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let inQuotes = false;
    for (const ch of text) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
        else if (!inQuotes && ch in counts) counts[ch] += 1;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : ',';
}

/** RFC 4180, leniently: quoted cells may hold separators, quotes ("") and newlines. */
function parseCsv(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === '"' && text[i + 1] === '"') {
                cell += '"';
                i += 1;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                cell += ch;
            }
            continue;
        }

        if (ch === '"' && cell.trim() === '') {
            cell = '';
            inQuotes = true;
        } else if (ch === delimiter) {
            row.push(cell);
            cell = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += ch;
        }
    }

    if (cell !== '' || row.length) {
        row.push(cell);
        rows.push(row);
    }

    return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** "Company Name" -> company_name. Keys must be usable as {{placeholders}}. */
function normaliseKey(header, index, taken) {
    let key = String(header || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    if (!key) key = `column_${index + 1}`;
    if (/^\d/.test(key)) key = `col_${key}`;

    let unique = key;
    for (let n = 2; taken.has(unique); n += 1) unique = `${key}_${n}`;
    taken.add(unique);
    return unique;
}

function cleanEmail(value) {
    return String(value || '').trim()
        .replace(/^mailto:/i, '')
        .replace(/^<(.*)>$/, '$1')
        .trim()
        .toLowerCase();
}

function isEmail(value) {
    return !emailRule.validate(value).error;
}

function typoSuggestion(email) {
    const at = email.lastIndexOf('@');
    if (at < 1) return null;
    const domain = email.slice(at + 1);
    const fixed = DOMAIN_TYPOS[domain] || (TLD_TYPO.test(domain) ? domain.replace(TLD_TYPO, '.com') : null);
    return fixed ? `${email.slice(0, at)}@${fixed}` : null;
}

/** "RAJESH kumar" -> "Rajesh". Only used when the sheet has no first-name column. */
function firstNameFrom(fullName) {
    const word = String(fullName || '').trim().split(/\s+/).find((w) => w && !HONORIFIC.test(w));
    if (!word) return '';
    const shouty = word === word.toUpperCase() || word === word.toLowerCase();
    return shouty ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word;
}

/**
 * @param {Buffer} buffer  the uploaded file, as bytes
 * @returns {{ rows: {email, data}[], columns: string[], total_rows: number,
 *             invalid: {row, value, reason}[], invalid_count: number,
 *             duplicates: number, error?: string }}
 */
function parseRecipients(buffer) {
    const empty = { rows: [], columns: [], total_rows: 0, invalid: [], invalid_count: 0, duplicates: 0 };

    const text = decode(buffer);
    const table = parseCsv(text, detectDelimiter(text));
    if (!table.length) return { ...empty, error: 'The file is empty.' };

    const taken = new Set();
    const headerKeys = table[0].map((h, i) => normaliseKey(h, i, taken));
    let emailIndex = headerKeys.findIndex((k) => ALIASES.email.includes(k));
    let keys = headerKeys;
    let dataRows = table.slice(1);
    let firstLine = 2;

    // No email header: accept a bare list, as long as the first line already
    // holds an address — that is a headerless file, not a mislabelled one.
    if (emailIndex === -1) {
        emailIndex = table[0].findIndex((cell) => isEmail(cleanEmail(cell)));
        if (emailIndex === -1) {
            return {
                ...empty,
                error: 'No email column found. Add a header row with a column named "email" '
                    + '(E-mail, Email ID and Email Address also work), or upload one address per line.'
            };
        }
        const plain = new Set();
        keys = table[0].map((_, i) => (i === emailIndex ? 'email' : normaliseKey('', i, plain)));
        dataRows = table;
        firstLine = 1;
    }

    if (dataRows.length > MAX_ROWS) {
        return {
            ...empty,
            total_rows: dataRows.length,
            error: `The list has ${dataRows.length.toLocaleString('en-IN')} rows. A campaign takes up to `
                + `${MAX_ROWS.toLocaleString('en-IN')} — split the file into smaller campaigns.`
        };
    }

    const rows = [];
    const invalid = [];
    let invalidCount = 0;
    let duplicates = 0;
    const seen = new Set();
    const columns = new Set(['email']);

    const reject = (row, value, reason) => {
        invalidCount += 1;
        if (invalid.length < MAX_REPORTED_INVALID) invalid.push({ row, value: String(value).slice(0, 120), reason });
    };

    dataRows.forEach((cells, i) => {
        const line = i + firstLine;
        const data = {};
        keys.forEach((key, c) => {
            const value = String(cells[c] === undefined ? '' : cells[c]).trim();
            if (value !== '') data[key] = value.slice(0, 500);
        });

        for (const [canonical, spellings] of Object.entries(ALIASES)) {
            if (canonical === 'email' || data[canonical]) continue;
            const from = spellings.find((k) => data[k]);
            if (from) data[canonical] = data[from];
        }

        const raw = cells[emailIndex] === undefined ? '' : cells[emailIndex];
        const email = cleanEmail(raw);
        if (!email) return reject(line, '', 'Email is empty');
        if (!isEmail(email)) return reject(line, raw, 'Not a valid email address');

        const typo = typoSuggestion(email);
        if (typo) return reject(line, raw, `Looks like a typo — did you mean ${typo}?`);

        if (seen.has(email)) {
            duplicates += 1;
            return undefined;
        }
        seen.add(email);

        // Keep the address under its canonical key only; the original header
        // ("Email ID") would just repeat it.
        keys.forEach((key, c) => { if (c === emailIndex) delete data[key]; });
        data.email = email;
        if (!data.first_name && data.name) data.first_name = firstNameFrom(data.name);

        Object.keys(data).forEach((k) => columns.add(k));
        rows.push({ email, data });
        return undefined;
    });

    const preferred = ['email', 'first_name', 'last_name', 'name', 'company'];
    const ordered = [
        ...preferred.filter((k) => columns.has(k)),
        ...[...columns].filter((k) => !preferred.includes(k))
    ];

    return {
        rows,
        columns: ordered,
        total_rows: dataRows.length,
        invalid,
        invalid_count: invalidCount,
        duplicates
    };
}

module.exports = { parseRecipients, isEmail, cleanEmail, MAX_ROWS };
