/**
 * WhatsApp through Meta's official WhatsApp Business Platform (Cloud API).
 *
 * The only route that does not get a number banned for bulk sending: a
 * business may start a conversation with a template Meta approved, and the
 * person can answer back for free for 24 hours. Everything here is a thin call
 * to the Graph API plus the translation of Meta's error codes into what to do.
 *
 *   WHATSAPP_GRAPH_URL       https://graph.facebook.com (tests point it at a stand-in)
 *   WHATSAPP_GRAPH_VERSION   v23.0
 */
const POSTGRESQLService = require('./POSTGRES');
const { decrypt } = require('./crypto');
const { merge } = require('./campaignRender');

const GRAPH_URL = (process.env.WHATSAPP_GRAPH_URL || 'https://graph.facebook.com').replace(/\/+$/, '');
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
const TIMEOUT_MS = 30 * 1000;

class WhatsAppError extends Error {
    constructor(message, { code = null, subcode = null, status = 0, details = '' } = {}) {
        super(message);
        this.code = code;
        this.subcode = subcode;
        this.status = status;
        this.details = details;
    }
}

/** The customer's account with its secrets decrypted, or null. */
async function accountOf(tenantId) {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT * FROM whatsapp_accounts WHERE tenant_id = $1 AND is_active`, [tenantId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return { ...row, token: decrypt(row.access_token_enc), appSecret: decrypt(row.app_secret_enc) };
}

async function graph(token, method, path, { query, body, headers, raw } = {}) {
    const url = new URL(`${GRAPH_URL}/${GRAPH_VERSION}/${path.replace(/^\/+/, '')}`);
    Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, v));

    let res;
    try {
        res = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
                ...headers
            },
            body: raw || (body !== undefined ? JSON.stringify(body) : undefined),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (error) {
        throw new WhatsAppError(`Could not reach WhatsApp: ${error.message}`, { code: 'NETWORK' });
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
        const e = json.error || {};
        throw new WhatsAppError(e.message || `WhatsApp answered ${res.status}`, {
            code: e.code ?? null,
            subcode: e.error_subcode ?? null,
            status: res.status,
            details: (e.error_data && e.error_data.details) || e.error_user_msg || ''
        });
    }
    return json;
}

/** What Meta says about the number right now, saved on the account. */
async function checkNumber(account) {
    const info = await graph(account.token, 'GET', account.phone_number_id, {
        query: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status' }
    });
    await POSTGRESQLService.PostgresAny(
        `UPDATE whatsapp_accounts
            SET display_phone = $2, verified_name = $3, quality_rating = $4, messaging_limit = $5,
                checked_at = now(), updated_at = now()
          WHERE id = $1`,
        [account.id, info.display_phone_number || null, info.verified_name || null,
            info.quality_rating || null, info.messaging_limit_tier || null]
    );
    return {
        display_phone: info.display_phone_number || null,
        verified_name: info.verified_name || null,
        quality_rating: info.quality_rating || null,
        messaging_limit: info.messaging_limit_tier || null,
        name_status: info.name_status || null
    };
}

/** Every template of the WhatsApp account, approved or not, newest pages included. */
async function listTemplates(account) {
    const templates = [];
    let after;
    for (let page = 0; page < 5; page += 1) {
        const res = await graph(account.token, 'GET', `${account.waba_id}/message_templates`, {
            query: {
                fields: 'id,name,status,category,language,components,parameter_format,rejected_reason,quality_score',
                limit: '100',
                ...(after ? { after } : {})
            }
        });
        templates.push(...(res.data || []));
        after = res.paging && res.paging.next && res.paging.cursors && res.paging.cursors.after;
        if (!after) break;
    }
    return templates;
}

function createTemplate(account, payload) {
    return graph(account.token, 'POST', `${account.waba_id}/message_templates`, { body: payload });
}

/**
 * Meta wants a sample of a template's header picture before it approves it,
 * sent through its resumable upload. Returns the handle the template refers to.
 */
async function uploadExample(account, content, contentType) {
    if (!account.app_id) {
        throw new WhatsAppError('A template with a picture needs the App ID. Add it in WhatsApp setup.', { code: 'NO_APP_ID' });
    }
    const session = await graph(account.token, 'POST', `${account.app_id}/uploads`, {
        query: { file_length: String(content.length), file_type: contentType }
    });
    const upload = await graph(account.token, 'POST', session.id, {
        raw: content,
        headers: { Authorization: `OAuth ${account.token}`, file_offset: '0', 'Content-Type': contentType }
    });
    return upload.h;
}

async function send(account, to, message) {
    const res = await graph(account.token, 'POST', `${account.phone_number_id}/messages`, {
        body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }
    });
    return res.messages && res.messages[0] && res.messages[0].id;
}

function sendTemplate(account, to, { name, language, components }) {
    return send(account, to, { type: 'template', template: { name, language: { code: language }, components } });
}

/** Free text — only allowed within 24 hours of the person's last message. */
function sendText(account, to, body) {
    return send(account, to, { type: 'text', text: { preview_url: false, body } });
}

// ------------------------------------------------------------- templates --

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function variablesIn(text) {
    const names = [];
    for (const m of String(text || '').matchAll(VARIABLE)) if (!names.includes(m[1])) names.push(m[1]);
    return names;
}

/**
 * The fill-in slots of a template: {{1}}, {{2}} or {{first_name}} in the
 * header text, the body and URL buttons, plus whether the header is a picture,
 * video or document that needs a link.
 */
function slotsOf(components) {
    const list = Array.isArray(components) ? components : [];
    const header = list.find((c) => c.type === 'HEADER');
    const body = list.find((c) => c.type === 'BODY');
    const buttons = (list.find((c) => c.type === 'BUTTONS') || {}).buttons || [];
    return {
        headerFormat: header ? header.format : null,
        header: header && header.format === 'TEXT' ? variablesIn(header.text) : [],
        body: body ? variablesIn(body.text) : [],
        buttons: buttons
            .map((b, index) => ({ index, names: b.type === 'URL' ? variablesIn(b.url) : [] }))
            .filter((b) => b.names.length)
    };
}

/** WhatsApp refuses parameters with line breaks, tabs or long runs of spaces. */
function cleanParameter(value) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000);
}

/**
 * The template's parameters for one person: each slot's merge text (e.g.
 * "{{first_name|Sir/Madam}}") filled from their row. `missing` names the slots
 * that came out empty — WhatsApp would refuse the message.
 */
function buildComponents(campaign, data) {
    const slots = slotsOf(campaign.template_components);
    const vars = campaign.variables || {};
    const named = campaign.template_format === 'NAMED';
    const missing = [];
    const components = [];

    const parameter = (name, template, where) => {
        const text = cleanParameter(merge(template || '', data));
        if (!text) missing.push(`${where} {{${name}}}`);
        return named ? { type: 'text', parameter_name: name, text } : { type: 'text', text };
    };

    const media = String(slots.headerFormat || '').toLowerCase();
    if (['image', 'video', 'document'].includes(media)) {
        const link = String(campaign.header_media_url || '').trim();
        if (!link) missing.push(`header ${media}`);
        const file = media === 'document' ? { filename: decodeURIComponent(link.split('/').pop() || 'document.pdf') } : {};
        components.push({ type: 'header', parameters: [{ type: media, [media]: { link, ...file } }] });
    } else if (slots.header.length) {
        components.push({ type: 'header', parameters: slots.header.map((n) => parameter(n, vars.header && vars.header[n], 'header')) });
    }
    if (slots.body.length) {
        components.push({ type: 'body', parameters: slots.body.map((n) => parameter(n, vars.body && vars.body[n], 'message')) });
    }
    slots.buttons.forEach(({ index, names }) => {
        const template = vars.buttons && vars.buttons[index];
        components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: names.map((n) => parameter(n, template, 'button link')) });
    });

    return { components, missing };
}

// ---------------------------------------------------------------- errors --

/**
 * What a failed send says about the rest of the list, like the email sender's
 * classify(): recipient (this number only), temporary (try again later) or
 * account (every message would fail the same way — pause and say why).
 */
function classify(error) {
    const code = error && error.code;
    if (code === 'NETWORK') return 'temporary';
    if ([131026, 131049, 131050, 131021, 131009, 135000].includes(code)) return 'recipient';
    if (code === 100 && /phone|recipient|\bto\b/i.test(`${error.message} ${error.details}`)) return 'recipient';
    if ([4, 80007, 130429, 131000, 131016, 131056, 131057, 133004].includes(code)) return 'temporary';
    if (error && error.status >= 500) return 'temporary';
    return 'account';
}

const EXPLANATIONS = {
    190: 'The access token has expired or was revoked. Create a permanent token for a System User (WhatsApp setup, step 3) and save it again.',
    10: 'The token is missing a permission. Give the System User whatsapp_business_messaging and whatsapp_business_management, and assign it the app and the WhatsApp account.',
    200: 'The token is missing a permission. Give the System User whatsapp_business_messaging and whatsapp_business_management.',
    131005: 'Meta refused access for this token. Check the System User has the WhatsApp account assigned with full control.',
    131026: 'This number is not on WhatsApp, or cannot receive messages from businesses.',
    131030: 'With Meta\'s test number you can only message numbers you added under "To" on the API Setup page. Add this number there, or connect your real number.',
    131031: 'Meta has locked this WhatsApp account. Open WhatsApp Manager to see why.',
    131042: 'Meta could not charge for messages. Add a payment method in WhatsApp Manager → Payment settings.',
    131045: 'This phone number is not registered with the Cloud API yet. Finish the registration in WhatsApp Manager.',
    131048: 'WhatsApp has limited this number because too many earlier messages were blocked or reported as spam. Sending is paused — give it a few days, and send only to people who expect to hear from you.',
    131049: 'Meta held this marketing message back to protect the person from too many business messages. Try them again in a few days.',
    131050: 'This person has turned off marketing messages from your business on WhatsApp.',
    131051: 'This kind of message cannot be sent.',
    131052: 'Meta could not download the header file. Check the link opens in a browser.',
    131053: 'Meta could not use the header file. Use a JPG or PNG under 5 MB, or a PDF under 100 MB.',
    131056: 'Too many messages to this person in a short time. Retrying later.',
    130429: 'WhatsApp is receiving messages too fast from this number. Retrying later.',
    132000: 'The template expects a different number of variables. Choose the template again in step 2.',
    132001: 'Meta has no approved template with this name in this language. Check its status in step 2.',
    132005: 'A variable made the message too long. Shorten the text that fills it.',
    132007: 'The message breaks WhatsApp\'s formatting rules.',
    132012: 'A variable has the wrong kind of value — for example the header needs a picture link.',
    132015: 'Meta paused this template because people rated it poorly. Create a new template and use that.',
    132016: 'Meta disabled this template. Create a new template and use that.',
    133010: 'This phone number is not registered with the Cloud API yet. Finish the registration in WhatsApp Manager.',
    368: 'Meta has temporarily blocked this account for a policy violation. See WhatsApp Manager → Account quality.',
    NO_APP_ID: 'A template with a picture needs the App ID. Add it in WhatsApp setup.'
};

function explain(error) {
    const code = error && error.code;
    if (code === 'NETWORK') return 'Could not reach WhatsApp. Check the server\'s internet connection; sending will retry.';
    const known = EXPLANATIONS[code];
    const meta = [error && error.message, error && error.details].filter(Boolean).join(' — ');
    if (known) return known;
    return meta ? `WhatsApp said: ${meta}` : 'WhatsApp refused the message.';
}

module.exports = {
    WhatsAppError, accountOf, checkNumber, listTemplates, createTemplate, uploadExample,
    sendTemplate, sendText, slotsOf, variablesIn, buildComponents, cleanParameter, classify, explain,
    GRAPH_VERSION
};
