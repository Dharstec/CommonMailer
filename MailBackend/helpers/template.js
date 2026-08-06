/**
 * Minimal, deliberately non-executing template renderer.
 *
 * Templates are written by you in the admin panel but filled with data typed by
 * anonymous visitors, so the substitution step must never be able to run code
 * or emit markup. No Handlebars/EJS here on purpose — those evaluate
 * expressions, and a template engine with visitor-controlled input is an
 * injection surface. All this does is replace {{key}} with escaped text.
 *
 * Supported syntax:
 *   {{field_key}}     value, HTML-escaped
 *   {{#all_fields}}   an auto-built table of every submitted field
 *   {{_date}} {{_ip}} {{_form_name}} {{_tenant_name}}  request metadata
 */

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
    '=': '&#61;'
};

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`=]/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Subject lines live in mail headers, where a newline would let a visitor append
 * their own headers (Bcc:, etc). Strip CR/LF and clamp the length.
 */
function sanitizeHeader(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, 200);
}

function displayValue(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (value === null || value === undefined) return '';
    return String(value);
}

/**
 * Builds the {{#all_fields}} table so a customer can get a complete, correct
 * notification without hand-writing a row per field — which is the whole point
 * when fields change from the admin panel.
 */
function buildAllFieldsTable(data, fields) {
    const rows = fields
        .filter((f) => f.field_type !== 'hidden' && data[f.field_key] !== undefined && data[f.field_key] !== '')
        .map((f) => `
            <tr>
              <td style="padding:10px 14px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;color:#374151;width:35%;vertical-align:top;">${escapeHtml(f.label)}</td>
              <td style="padding:10px 14px;border:1px solid #e5e7eb;color:#111827;white-space:pre-wrap;">${escapeHtml(displayValue(data[f.field_key]))}</td>
            </tr>`)
        .join('');

    if (!rows) return '<p style="color:#6b7280;">No data submitted.</p>';

    return `<table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${rows}</table>`;
}

function buildAllFieldsText(data, fields) {
    return fields
        .filter((f) => f.field_type !== 'hidden' && data[f.field_key] !== undefined && data[f.field_key] !== '')
        .map((f) => `${f.label}: ${displayValue(data[f.field_key])}`)
        .join('\n');
}

/**
 * @param {string} template  the stored subject / html_body / text_body
 * @param {Object} data      validated submission values, keyed by field_key
 * @param {Array}  fields    form_fields rows (for labels and {{#all_fields}})
 * @param {Object} meta      { date, ip, form_name, tenant_name }
 * @param {Object} opts      { escape: boolean } — false for the plain-text part
 */
function render(template, data, fields, meta = {}, opts = {}) {
    if (!template) return '';
    const shouldEscape = opts.escape !== false;
    const out = shouldEscape ? escapeHtml : displayValue;

    return String(template).replace(/\{\{\s*([#\w.]+)\s*\}\}/g, (match, key) => {
        if (key === '#all_fields') {
            return shouldEscape ? buildAllFieldsTable(data, fields) : buildAllFieldsText(data, fields);
        }
        if (key === '_date') return out(meta.date || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
        if (key === '_ip') return out(meta.ip || '');
        if (key === '_form_name') return out(meta.form_name || '');
        if (key === '_tenant_name') return out(meta.tenant_name || '');

        if (Object.prototype.hasOwnProperty.call(data, key)) {
            return out(displayValue(data[key]));
        }
        // Unknown placeholder: emit nothing rather than leaving {{typo}} in the
        // customer's email.
        return '';
    });
}

/** Wraps a rendered body in a neutral, email-client-safe shell. */
function wrapHtml(innerHtml, headline) {
    return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
      ${headline ? `<div style="background:#111827;color:#ffffff;padding:18px 24px;font-size:17px;font-weight:600;">${escapeHtml(headline)}</div>` : ''}
      <div style="padding:24px;color:#111827;font-size:14px;line-height:1.6;">
        ${innerHtml}
      </div>
    </div>
  </body>
</html>`;
}

/** Default bodies used when a form is created without custom templates. */
const DEFAULTS = {
    admin: {
        subject: 'New enquiry from {{_form_name}}',
        html_body: '<p>You have received a new enquiry.</p>{{#all_fields}}<p style="margin-top:18px;color:#6b7280;font-size:12px;">Received {{_date}} from IP {{_ip}}</p>',
        text_body: 'New enquiry\n\n{{#all_fields}}\n\nReceived {{_date}} from IP {{_ip}}'
    },
    autoreply: {
        subject: 'Thank you for contacting {{_tenant_name}}',
        html_body: '<p>Hello,</p><p>Thank you for reaching out. We have received your message and our team will get back to you shortly.</p><p style="margin-top:18px;">A copy of your submission:</p>{{#all_fields}}<p style="margin-top:18px;">Warm regards,<br/>{{_tenant_name}}</p>',
        text_body: 'Hello,\n\nThank you for reaching out. We have received your message and will get back to you shortly.\n\nYour submission:\n{{#all_fields}}\n\nWarm regards,\n{{_tenant_name}}'
    }
};

module.exports = { render, escapeHtml, sanitizeHeader, wrapHtml, displayValue, DEFAULTS };
