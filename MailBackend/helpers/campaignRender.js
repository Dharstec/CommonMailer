/**
 * Campaign email rendering: the designs, {{merge}} fields, and the light
 * formatting people type into the message box.
 *
 * Built for mail clients, not browsers: table layout, inline styles, a 600px
 * fluid container with an Outlook "ghost" table, bulletproof buttons, and
 * designs that still read when images are blocked. Every message also gets a
 * plain-text part — multipart mail is what spam filters expect to see and what
 * a text-only client shows.
 *
 * Recipient values come from someone else's spreadsheet, so the rule from
 * helpers/template.js holds here too: everything is escaped before it becomes
 * markup, and formatting is only ever applied to already-escaped text.
 */
const { escapeHtml, sanitizeHeader } = require('./template');

const DEFAULT_BRAND = '#4f46e5';
const DESIGN_KEYS = ['executive', 'spotlight', 'aurora', 'personal', 'custom'];

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const RICH = { font: FONT, size: 16, line: 26, color: '#334155' };
// The personal design should look typed, not designed: the default font of a
// mail client, slightly smaller, no colour beyond links.
const PLAIN = { font: 'Arial,Helvetica,sans-serif', size: 15, line: 24, color: '#1f2937' };

// ------------------------------------------------------------------ merge --

/** {{key}} or {{key|fallback}}. Keys are matched case-insensitively. */
const MERGE_TAG = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|([^{}]*?))?\s*\}\}/g;

function merge(template, data, encode = (v) => v) {
    if (template === null || template === undefined) return '';
    return String(template).replace(MERGE_TAG, (match, key, fallback) => {
        const value = data[key.toLowerCase()];
        const text = value === undefined || value === null || String(value).trim() === ''
            ? String(fallback || '').trim()
            : String(value);
        return encode(text);
    });
}

/**
 * A link may carry merge fields (…?ref={{email}}). Values going into a URL are
 * percent-encoded — unless the whole URL is one field, as with a per-company
 * {{website}} column, where encoding would break it.
 */
function mergeUrl(template, data) {
    const source = String(template || '').trim();
    if (/^\{\{[^}]+\}\}$/.test(source)) return merge(source, data).trim();
    return merge(source, data, encodeURIComponent).trim();
}

// ----------------------------------------------------------------- colour --

function parseHex(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!match) return null;
    const n = parseInt(match[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
    return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

function mix(hex, other, amount) {
    const a = parseHex(hex);
    const b = parseHex(other);
    return toHex(a.map((v, i) => v + (b[i] - v) * amount));
}

function luminance(hex) {
    const weights = [0.2126, 0.7152, 0.0722];
    return parseHex(hex)
        .map((v) => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, c, i) => sum + c * weights[i], 0);
}

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

function hueShift(hex, degrees) {
    const [r, g, b] = parseHex(hex).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return hex;

    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + degrees + 360) % 360;

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return toHex([r1, g1, b1].map((v) => (v + m) * 255));
}

function hueOf(hex) {
    const [r, g, b] = parseHex(hex);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}

/**
 * Everything a design needs from one brand colour. Text colours are chosen by
 * contrast rather than trusted, so a pale brand colour gets dark button text
 * and links that are still readable on white.
 */
function theme(brandInput) {
    const brand = parseHex(brandInput) ? toHex(parseHex(brandInput)) : DEFAULT_BRAND;

    let link = brand;
    for (let i = 0; i < 12 && contrast(link, '#ffffff') < 4.5; i += 1) link = mix(link, '#000000', 0.12);

    // The gradient's second stop. Cool hues and reds drift toward violet and
    // orange, which reads as a deliberate gradient; yellows drift the other
    // way, because yellow-to-green looks like a mistake.
    const hue = hueOf(brand);
    const deep = hueShift(mix(brand, '#000000', 0.18), hue >= 30 && hue <= 90 ? -30 : 32);

    return {
        brand,
        link,
        deep,
        onBrand: contrast(brand, '#ffffff') >= 3 ? '#ffffff' : '#0f172a',
        soft: mix(brand, '#ffffff', 0.93),
        tint: mix(brand, '#ffffff', 0.85),
        shadow: `rgba(${parseHex(brand).join(',')},0.28)`
    };
}

// ------------------------------------------------------------- formatting --

function isHttpUrl(value) {
    return /^https?:\/\/[^\s"'<>]+$/i.test(String(value || '').trim());
}

function isLinkTarget(value) {
    return /^(https?:\/\/|mailto:|tel:)[^\s"'<>]+$/i.test(String(value || '').trim());
}

const LINK_OR_URL = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;

/** Bold and links, on text that is already escaped. */
function inline(escaped, t) {
    const anchor = (href, label) => `<a href="${href}" target="_blank" style="color:${t.link};text-decoration:underline;">${label}</a>`;

    return escaped
        .replace(LINK_OR_URL, (match, label, href, bare) => {
            if (href) return anchor(href, label);
            const trailing = (bare.match(/[.,;:!?)]+$/) || [''])[0];
            const url = trailing ? bare.slice(0, -trailing.length) : bare;
            return anchor(url, url) + trailing;
        })
        .replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:700;color:#0f172a;">$1</strong>');
}

function paragraph(lines, t, typo) {
    return `<p style="margin:0 0 18px;font-family:${typo.font};font-size:${typo.size}px;line-height:${typo.line}px;color:${typo.color};">${lines.map((l) => inline(l, t)).join('<br>')}</p>`;
}

/** Check-mark or numbered rows. Tables, not <ul>: Outlook mangles list indents. */
function richList(items, numbered, t, typo) {
    const rows = items.map((item, i) => `<tr>
<td width="34" valign="top" style="width:34px;padding:2px 0 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="22" height="22" align="center" valign="middle" bgcolor="${t.tint}" style="width:22px;height:22px;border-radius:11px;background-color:${t.tint};color:${t.link};font-family:${FONT};font-size:12px;font-weight:700;line-height:22px;">${numbered ? i + 1 : '&#10003;'}</td>
</tr></table>
</td>
<td valign="top" style="padding:0 0 12px;font-family:${typo.font};font-size:${typo.size}px;line-height:${typo.line}px;color:${typo.color};">${inline(item, t)}</td>
</tr>`).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">${rows}</table>`;
}

function plainList(items, numbered, t, typo) {
    const tag = numbered ? 'ol' : 'ul';
    const lis = items.map((item) => `<li style="margin:0 0 6px;">${inline(item, t)}</li>`).join('');
    return `<${tag} style="margin:0 0 18px;padding-left:22px;font-family:${typo.font};font-size:${typo.size}px;line-height:${typo.line}px;color:${typo.color};">${lis}</${tag}>`;
}

const DIVIDER = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:6px 0 26px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#e2e8f0" style="height:1px;background-color:#e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table>';

/**
 * What the message box understands. Kept to things people already type in
 * plain email:
 *
 *   blank line   new paragraph        **bold**         bold
 *   - item       check-mark list      1. item          numbered list
 *   ## Title     sub-heading          ---              divider
 *   [text](https://…) and bare https://… links
 */
function formatText(text, t, typo, { plainLists = false } = {}) {
    const escaped = escapeHtml(String(text || '').replace(/\r\n?/g, '\n')).trim();
    if (!escaped) return '';

    return escaped.split(/\n[ \t]*\n+/).map((block) => {
        const groups = [];
        for (const line of block.split('\n').map((l) => l.trim()).filter(Boolean)) {
            let kind = 'p';
            if (/^-{3,}$/.test(line)) kind = 'hr';
            else if (/^[-*•]\s+/.test(line)) kind = 'ul';
            else if (/^\d{1,3}[.)]\s+/.test(line)) kind = 'ol';
            else if (/^#{1,3}\s+/.test(line)) kind = 'h';

            const last = groups[groups.length - 1];
            if (last && last.kind === kind && ['p', 'ul', 'ol'].includes(kind)) last.lines.push(line);
            else groups.push({ kind, lines: [line] });
        }

        return groups.map(({ kind, lines }) => {
            if (kind === 'hr') return DIVIDER;
            if (kind === 'h') {
                const title = inline(lines[0].replace(/^#{1,3}\s+/, ''), t);
                return `<h2 style="margin:6px 0 12px;font-family:${typo.font};font-size:${typo.size + 4}px;line-height:${typo.line + 2}px;font-weight:700;color:#0f172a;">${title}</h2>`;
            }
            if (kind === 'ul' || kind === 'ol') {
                const items = lines.map((l) => l.replace(/^([-*•]|\d{1,3}[.)])\s+/, ''));
                return plainLists ? plainList(items, kind === 'ol', t, typo) : richList(items, kind === 'ol', t, typo);
            }
            return paragraph(lines, t, typo);
        }).join('');
    }).join('');
}

function stripFormatting(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
        .replace(/^#{1,3}\s+/gm, '')
        .replace(/^-{3,}$/gm, '')
        .replace(/^[*•]\s+/gm, '- ');
}

const NAMED_ENTITIES = {
    nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…',
    copy: '©', reg: '®', trade: '™', rarr: '→', zwnj: '', shy: ''
};

/** Good-enough text part for a hand-written HTML campaign. */
function htmlToText(html) {
    return String(html || '')
        .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
            const text = label.replace(/<[^>]+>/g, '').trim();
            return text && text !== href ? `${text} (${href})` : href;
        })
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|tr|li|table|blockquote)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, name) => (name.toLowerCase() in NAMED_ENTITIES ? NAMED_ENTITIES[name.toLowerCase()] : m))
        .replace(/&amp;/gi, '&')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ------------------------------------------------------------ components --

function logo(c, color, { center = false } = {}) {
    const width = Math.min(300, Math.max(40, parseInt(c.content.logo_width, 10) || 140));
    if (isHttpUrl(c.content.logo_url)) {
        return `<img src="${escapeHtml(c.content.logo_url.trim())}" width="${width}" alt="${c.company}" style="display:block;width:${width}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;${center ? 'margin:0 auto;' : ''}font-family:${FONT};font-size:18px;font-weight:700;color:${color};">`;
    }
    return `<span style="font-family:${FONT};font-size:19px;font-weight:800;letter-spacing:-0.2px;color:${color};">${c.company}</span>`;
}

function heroImage(c, width, radius = 0) {
    if (!isHttpUrl(c.content.hero_image_url)) return '';
    return `<img src="${escapeHtml(c.content.hero_image_url.trim())}" width="${width}" alt="${c.headline || c.company}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;border-radius:${radius}px;">`;
}

/**
 * Mark Robbins' bulletproof button: one <a> that is fully clickable everywhere,
 * with the Outlook-only <i> spacers giving it padding where Outlook ignores CSS.
 */
function button(c, { center = false, large = false } = {}) {
    if (!c.cta) return '';
    const { t } = c;
    const pad = large ? '17px 34px' : '15px 30px';
    const size = large ? 17 : 16;
    const a = `<a href="${c.cta.url}" target="_blank" style="background-color:${t.brand};border-radius:10px;color:${t.onBrand};display:inline-block;font-family:${FONT};font-size:${size}px;font-weight:700;line-height:20px;padding:${pad};text-decoration:none;box-shadow:0 8px 20px ${t.shadow};mso-padding-alt:0;"><!--[if mso]><i style="mso-font-width:150%;mso-text-raise:28pt" hidden>&emsp;</i><span style="mso-text-raise:14pt;"><![endif]-->${c.cta.text}<!--[if mso]></span><i style="mso-font-width:150%;" hidden>&emsp;&#8203;</i><![endif]--></a>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${center ? 'center' : 'left'}" style="padding:6px 0 30px;">${a}</td></tr></table>`;
}

/** Plain-text-looking call to action for the personal design. */
function textLink(c) {
    if (!c.cta) return '';
    return `<p style="margin:0 0 18px;font-family:${c.typo.font};font-size:${c.typo.size}px;line-height:${c.typo.line}px;"><a href="${c.cta.url}" target="_blank" style="color:${c.t.link};font-weight:700;text-decoration:underline;">${c.cta.text} &rarr;</a></p>`;
}

const FILE_KINDS = [
    { ext: ['pdf'], label: 'PDF document', color: '#dc2626' },
    { ext: ['ppt', 'pptx', 'pps', 'ppsx', 'key', 'odp'], label: 'Presentation', color: '#ea580c' },
    { ext: ['doc', 'docx', 'odt', 'rtf', 'pages'], label: 'Document', color: '#2563eb' },
    { ext: ['xls', 'xlsx', 'xlsm', 'csv', 'ods', 'numbers'], label: 'Spreadsheet', color: '#16a34a' },
    { ext: ['zip', 'rar', '7z', 'gz', 'tar'], label: 'Archive', color: '#7c3aed' },
    { ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg'], label: 'Image', color: '#0891b2' },
    { ext: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav'], label: 'Media', color: '#db2777' }
];

function fileKind(filename) {
    const ext = String(filename).includes('.') ? String(filename).split('.').pop().toLowerCase() : '';
    const kind = FILE_KINDS.find((k) => k.ext.includes(ext)) || { label: 'File', color: '#475569' };
    return { ...kind, badge: (ext || 'file').slice(0, 4).toUpperCase() };
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
}

/**
 * Attachments are easy to miss below a long message, and a recipient who
 * misses the deck never opens it — so the designs point at them by name.
 */
function attachmentCard(c) {
    if (!c.attachments.length) return '';
    const rows = c.attachments.map((file, i) => {
        const kind = fileKind(file.filename);
        return `<tr><td style="padding:12px 0;${i ? 'border-top:1px solid #e2e8f0;' : ''}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="44" valign="middle" style="width:44px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="44" align="center" valign="middle" bgcolor="${kind.color}" style="width:44px;height:44px;border-radius:10px;background-color:${kind.color};color:#ffffff;font-family:${FONT};font-size:10px;font-weight:800;letter-spacing:0.04em;line-height:44px;">${escapeHtml(kind.badge)}</td></tr></table>
</td>
<td valign="middle" style="padding-left:14px;font-family:${FONT};">
<p style="margin:0;font-size:15px;line-height:21px;font-weight:600;color:#0f172a;word-break:break-word;">${escapeHtml(file.filename)}</p>
<p style="margin:0;font-size:13px;line-height:19px;color:#64748b;">${kind.label} &middot; ${formatBytes(file.size_bytes)}</p>
</td>
</tr></table>
</td></tr>`;
    }).join('');

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 30px;">
<tr><td style="padding:0 0 10px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Attached to this email</td></tr>
<tr><td bgcolor="#f8fafc" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:4px 18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
</td></tr>
</table>`;
}

function attachmentLine(c) {
    if (!c.attachments.length) return '';
    const names = c.attachments
        .map((f) => `<strong style="color:#0f172a;">${escapeHtml(f.filename)}</strong> (${formatBytes(f.size_bytes)})`)
        .join(', ');
    return `<p style="margin:0 0 18px;font-family:${c.typo.font};font-size:14px;line-height:22px;color:#475569;">&#128206; Attached: ${names}</p>`;
}

/**
 * "Warm regards," / name / title / phone. A first line ending in a comma is the
 * sign-off, so the line after it is the name and gets the weight.
 */
function signatureBlock(text, t, typo) {
    const lines = escapeHtml(text).split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    const nameAt = lines.length > 1 && /,$/.test(lines[0]) ? 1 : 0;

    const html = lines.map((line, i) => {
        if (i < nameAt) {
            return `<p style="margin:0;font-family:${typo.font};font-size:${typo.size}px;line-height:${typo.line}px;color:${typo.color};">${inline(line, t)}</p>`;
        }
        if (i === nameAt) {
            return `<p style="margin:${nameAt ? '6px' : '0'} 0 0;font-family:${typo.font};font-size:${typo.size}px;line-height:${typo.line}px;font-weight:700;color:#0f172a;">${inline(line, t)}</p>`;
        }
        return `<p style="margin:0;font-family:${typo.font};font-size:14px;line-height:22px;color:#64748b;">${inline(line, t)}</p>`;
    }).join('');

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:4px 0 0;">${html}</td></tr></table>`;
}

/**
 * Who sent this, to whom, and how to stop it. Required by anti-spam law, and
 * a visible unsubscribe is what keeps a recipient from pressing "Report spam"
 * instead — which costs far more reputation than one lost address.
 */
function footerBlock(c, { align = 'center', border = false } = {}) {
    const address = escapeHtml(c.footerText.trim()).replace(/\n/g, '<br>');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${align}" style="padding:${border ? '22px 0 8px' : '30px 24px 8px'};${border ? 'border-top:1px solid #e5e7eb;' : ''}font-family:${FONT};font-size:12px;line-height:19px;color:#94a3b8;text-align:${align};">
${address ? `<p style="margin:0 0 10px;">${address}</p>` : ''}
<p style="margin:0;">This email was sent to <span style="color:#64748b;">${c.email}</span> by ${c.company}.<br>Not interested? <a href="${c.unsubscribeUrl}" target="_blank" style="color:#64748b;text-decoration:underline;">Unsubscribe</a> and you won&#39;t hear from us again.</p>
</td></tr></table>`;
}

function headline(c, { size = 28, line = 36, color = '#0f172a', center = false, margin = '0 0 18px' } = {}) {
    if (!c.headline) return '';
    return `<h1 class="cm-h1" style="margin:${margin};font-family:${FONT};font-size:${size}px;line-height:${line}px;font-weight:800;letter-spacing:-0.4px;color:${color};${center ? 'text-align:center;' : ''}">${c.headline}</h1>`;
}

/**
 * The 600px fluid container, with a fixed-width table for Outlook only.
 * `separate` because collapsed tables drop border-radius on bordered cells.
 */
function frame(bg, rows, { top = 32 } = {}) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background-color:${bg};">
<tr><td align="center" style="padding:${top}px 12px 28px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;border-collapse:separate;">
${rows}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>`;
}

// ---------------------------------------------------------------- designs --

const DESIGNS = {
    /** White card with a brand-coloured top edge, left-aligned letter. For proposals with a deck attached. */
    executive: {
        bg: () => '#f1f5f9',
        render(c) {
            const hero = heroImage(c, 512, 10);
            return frame('#f1f5f9', `
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e2e8f0;border-top:6px solid ${c.t.brand};border-radius:14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="cm-px" style="padding:30px 44px 0;">${logo(c, '#0f172a')}</td></tr>
${hero ? `<tr><td class="cm-px" style="padding:26px 44px 0;">${hero}</td></tr>` : ''}
<tr><td class="cm-px" style="padding:30px 44px 40px;">
${headline(c)}
${c.body}
${button(c)}
${attachmentCard(c)}
${c.signature}
</td></tr>
</table>
</td></tr>
<tr><td>${footerBlock(c)}</td></tr>`);
        }
    },

    /** Brand header band, centred headline, big button. For launches and announcements. */
    spotlight: {
        bg: (t) => t.soft,
        render(c) {
            const hero = heroImage(c, 600);
            const accent = `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:22px auto 0;"><tr><td width="56" height="4" bgcolor="${c.t.brand}" style="width:56px;height:4px;background-color:${c.t.brand};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
            return frame(c.t.soft, `
<tr><td align="center" bgcolor="${c.t.brand}" class="cm-px" style="background-color:${c.t.brand};border-radius:16px 16px 0 0;padding:28px 40px;">${logo(c, c.t.onBrand, { center: true })}</td></tr>
${hero ? `<tr><td bgcolor="#ffffff" style="background-color:#ffffff;font-size:0;line-height:0;">${hero}</td></tr>` : ''}
${c.headline ? `<tr><td align="center" bgcolor="#ffffff" class="cm-px" style="background-color:#ffffff;padding:44px 48px 0;">${headline(c, { size: 32, line: 40, center: true, margin: '0' })}${accent}</td></tr>` : ''}
<tr><td bgcolor="#ffffff" class="cm-px" style="background-color:#ffffff;padding:32px 48px 0;">${c.body}</td></tr>
${c.cta ? `<tr><td bgcolor="#ffffff" class="cm-px" style="background-color:#ffffff;padding:4px 48px 0;">${button(c, { center: true, large: true })}</td></tr>` : ''}
<tr><td bgcolor="#ffffff" class="cm-px" style="background-color:#ffffff;padding:10px 48px 44px;border-radius:0 0 16px 16px;">${attachmentCard(c)}${c.signature}</td></tr>
<tr><td>${footerBlock(c)}</td></tr>`);
        }
    },

    /** Gradient hero with the headline in it. For offers, events and anything that should feel exciting. */
    aurora: {
        bg: () => '#eef1f6',
        render(c) {
            const hero = heroImage(c, 600);
            return frame('#eef1f6', `
<tr><td bgcolor="${c.t.brand}" class="cm-px" style="background-color:${c.t.brand};background-image:linear-gradient(135deg,${c.t.brand} 0%,${c.t.deep} 100%);border-radius:18px 18px 0 0;padding:38px 48px 46px;">
${logo(c, c.t.onBrand)}
${c.headline ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="44" style="height:44px;font-size:0;line-height:0;">&nbsp;</td></tr></table>${headline(c, { size: 34, line: 42, color: c.t.onBrand, margin: '0' })}` : ''}
</td></tr>
${hero ? `<tr><td bgcolor="#ffffff" style="background-color:#ffffff;font-size:0;line-height:0;">${hero}</td></tr>` : ''}
<tr><td bgcolor="#ffffff" class="cm-px" style="background-color:#ffffff;padding:40px 48px 44px;border-radius:0 0 18px 18px;">
${c.body}
${button(c, { large: true })}
${attachmentCard(c)}
${c.signature}
</td></tr>
<tr><td>${footerBlock(c)}</td></tr>`);
        }
    },

    /**
     * Looks like an email a person typed. No banner, no images, one link: the
     * shape most likely to land in Gmail's Primary tab rather than Promotions,
     * and the one that gets replies.
     */
    personal: {
        bg: () => '#ffffff',
        render(c) {
            return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background-color:#ffffff;">
<tr><td align="left" style="padding:28px 20px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="font-family:${c.typo.font};font-size:${c.typo.size}px;line-height:${c.typo.line}px;color:${c.typo.color};">
${c.body}
${textLink(c)}
${attachmentLine(c)}
${c.signature}
</td></tr>
<tr><td style="padding-top:30px;">${footerBlock(c, { align: 'left', border: true })}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>`;
        }
    }
};

/**
 * The hidden inbox preview line. The filler after it stops the client from
 * pulling the first words of the body ("View in browser", the logo's alt
 * text) into the preview after our text runs out.
 */
function preheaderBlock(text) {
    if (!text) return '';
    return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;font-family:sans-serif;">${escapeHtml(text)}${'&#847;&zwnj;&nbsp;'.repeat(90)}</div>`;
}

function shell({ title, preheader, bg, body }) {
    return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>table,td,p,a,span,h1,h2,li{font-family:Arial,Helvetica,sans-serif !important;}</style>
<![endif]-->
<style>
body{margin:0;padding:0;width:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{-ms-interpolation-mode:bicubic;}
@media only screen and (max-width:620px){
.cm-px{padding-left:24px !important;padding-right:24px !important;}
.cm-h1{font-size:26px !important;line-height:34px !important;}
}
</style>
</head>
<body style="margin:0;padding:0;background-color:${bg};word-spacing:normal;">
${preheaderBlock(preheader)}
<div role="article" aria-roledescription="email" lang="en" style="background-color:${bg};">
${body}
</div>
</body>
</html>`;
}

function renderCustom({ campaign, data, subject, preheader, unsubscribeUrl, pixel, footerContext }) {
    const source = String(campaign.custom_html || '');
    let html = merge(source, { ...data, _unsubscribe_url: unsubscribeUrl }, escapeHtml);
    const text = `${htmlToText(html)}\n\n--\nUnsubscribe: ${unsubscribeUrl}`;

    // Every campaign carries a way out, whatever the hand-written HTML forgot.
    const extra = (/\{\{\s*_unsubscribe_url\s*\}\}/i.test(source) ? '' : footerBlock(footerContext)) + pixel;

    if (/<html[\s>]/i.test(html)) {
        if (preheader) html = html.replace(/<body([^>]*)>/i, (m) => `${m}${preheaderBlock(preheader)}`);
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${extra}</body>`) : html + extra;
    } else {
        html = shell({ title: subject, preheader, bg: '#ffffff', body: html + extra });
    }
    return { subject, preheader, html, text };
}

/**
 * @param {Object} o
 * @param {Object} o.campaign        a campaigns row, or an unsaved draft of one
 * @param {Object} o.data            the recipient's merge values (includes email)
 * @param {Array}  [o.attachments]   [{ filename, size_bytes }] — names only, for the body
 * @param {string} o.company         the customer's name, shown when there is no logo
 * @param {string} o.unsubscribeUrl
 * @param {string} [o.pixelUrl]      left out for previews and tests
 * @returns {{ subject: string, preheader: string, html: string, text: string }}
 */
function renderCampaign({ campaign, data, attachments = [], company, unsubscribeUrl, pixelUrl }) {
    const content = campaign.content || {};
    const t = theme(content.brand_color);
    const subject = sanitizeHeader(merge(campaign.subject, data));
    const preheader = merge(campaign.preheader, data).replace(/\s+/g, ' ').trim();
    const pixel = pixelUrl
        ? `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">`
        : '';

    const base = {
        t,
        typo: RICH,
        content,
        company: escapeHtml(company),
        email: escapeHtml(data.email || ''),
        unsubscribeUrl: escapeHtml(unsubscribeUrl),
        footerText: merge(content.footer_text, data)
    };

    if (campaign.design === 'custom') {
        return renderCustom({ campaign, data, subject, preheader, unsubscribeUrl, pixel, footerContext: base });
    }

    const personal = campaign.design === 'personal';
    const typo = personal ? PLAIN : RICH;
    const parts = {
        headline: personal ? '' : merge(content.headline, data).trim(),
        body: merge(content.body, data),
        ctaText: merge(content.cta_text, data).trim(),
        ctaUrl: mergeUrl(content.cta_url, data),
        signature: merge(content.signature, data)
    };

    const c = {
        ...base,
        typo,
        attachments,
        headline: escapeHtml(parts.headline).replace(/\n/g, '<br>'),
        body: formatText(parts.body, t, typo, { plainLists: personal }),
        cta: parts.ctaText && isLinkTarget(parts.ctaUrl)
            ? { text: escapeHtml(parts.ctaText), url: escapeHtml(parts.ctaUrl) }
            : null,
        signature: signatureBlock(parts.signature, t, typo)
    };

    const design = DESIGNS[campaign.design] || DESIGNS.executive;
    const html = shell({ title: subject, preheader, bg: design.bg(t), body: design.render(c) + pixel });

    const text = [
        parts.headline,
        stripFormatting(parts.body).trim(),
        c.cta ? `${parts.ctaText}: ${parts.ctaUrl}` : '',
        attachments.length ? `Attached: ${attachments.map((f) => f.filename).join(', ')}` : '',
        parts.signature.trim(),
        ['--', base.footerText.trim(), `This email was sent to ${data.email || ''} by ${company}.`, `Unsubscribe: ${unsubscribeUrl}`]
            .filter(Boolean).join('\n')
    ].filter(Boolean).join('\n\n');

    return { subject, preheader, html, text };
}

module.exports = { renderCampaign, merge, formatBytes, DESIGN_KEYS, DEFAULT_BRAND };
