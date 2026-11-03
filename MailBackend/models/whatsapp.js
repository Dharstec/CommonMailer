/**
 * WhatsApp campaigns, admin side — the email campaigns' twin (models/campaign.js)
 * on Meta's official WhatsApp Business Platform:
 *
 *   setup       connect a customer's number: IDs, token, app secret, webhook
 *   templates   list what Meta approved, and submit new ones for approval
 *   campaigns   one approved template, a list of mobile numbers, a safe pace
 *   replies     what came back, answerable for 24 hours from the panel
 *
 * The sending itself is helpers/whatsappWorker.js; delivery receipts and
 * replies arrive at models/whatsappWebhook.js.
 */
const crypto = require('crypto');
const POSTGRESQLService = require('../helpers/POSTGRES');
const { encrypt } = require('../helpers/crypto');
const whatsapp = require('../helpers/whatsapp');
const { pace } = require('../helpers/whatsappWorker');
const images = require('../helpers/images');
const sendWindow = require('../helpers/sendWindow');
const { parsePhoneList } = require('../helpers/campaignCsv');
const { normalisePhone, formatPhone } = require('../helpers/phone');
const { baseUrl } = require('../helpers/links');
const logger = require('../helpers/logger');

const handleServerError = (res, error, where) => {
    logger.error(`${where} failed`, { error: error.message, stack: error.stack });
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};

const EDITABLE = ['draft', 'scheduled', 'paused'];

const EMPTY_STATS = { total: 0, pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, replied: 0 };

const RECIPIENT_FILTERS = new Map([
    ['pending', `r.status = 'pending'`],
    ['sent', `r.status IN ('sent', 'delivered', 'read')`],
    ['delivered', `r.status IN ('delivered', 'read')`],
    ['read', `r.status = 'read'`],
    ['replied', 'r.replied_at IS NOT NULL'],
    ['failed', `r.status = 'failed'`],
    ['skipped', `r.status = 'skipped'`]
]);

function idParam(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function notFound(res, what = 'Campaign') {
    return res.status(404).json({ status: 'error', message: `${what} not found` });
}

function webhookUrl() {
    return `${baseUrl()}/api/wa/webhook`;
}

async function tenantExists(tenantId) {
    const rows = await POSTGRESQLService.PostgresAny(`SELECT id, name FROM tenants WHERE id = $1`, [tenantId]);
    return rows[0] || null;
}

/** The account as the panel may see it: never the token or the app secret. */
function presentAccount(row) {
    if (!row) return null;
    return {
        phone_number_id: row.phone_number_id,
        waba_id: row.waba_id,
        app_id: row.app_id,
        default_country: row.default_country,
        notify_emails: row.notify_emails,
        display_phone: row.display_phone,
        verified_name: row.verified_name,
        quality_rating: row.quality_rating,
        messaging_limit: row.messaging_limit,
        checked_at: row.checked_at,
        webhook_seen_at: row.webhook_seen_at,
        has_token: Boolean(row.access_token_enc),
        has_app_secret: Boolean(row.app_secret_enc)
    };
}

async function accountRow(tenantId) {
    const rows = await POSTGRESQLService.PostgresAny(`SELECT * FROM whatsapp_accounts WHERE tenant_id = $1`, [tenantId]);
    return rows[0] || null;
}

// ---------------------------------------------------------------- setup --

/** Every customer, and whether its WhatsApp is connected — for the pickers. */
const listAccounts = async (req, res) => {
    try {
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT t.id AS tenant_id, t.name AS tenant_name, (a.id IS NOT NULL) AS connected,
                    a.display_phone, a.verified_name, a.quality_rating, a.messaging_limit, a.webhook_seen_at,
                    (s.id IS NOT NULL AND s.is_active) AS smtp_ready
               FROM tenants t
               LEFT JOIN whatsapp_accounts a ON a.tenant_id = t.id AND a.is_active
               LEFT JOIN tenant_smtp s ON s.tenant_id = t.id
              ORDER BY t.name`,
            []
        );
        res.json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.listAccounts');
    }
};

async function accountDetail(tenant) {
    const row = await accountRow(tenant.id);
    return {
        tenant_id: tenant.id,
        tenant_name: tenant.name,
        connected: Boolean(row),
        account: presentAccount(row),
        webhook: row ? { url: webhookUrl(), verify_token: row.verify_token } : null,
        pace: await pace.status(tenant.id)
    };
}

const getAccount = async (req, res) => {
    try {
        const tenant = await tenantExists(idParam(req.params.tenantId));
        if (!tenant) return notFound(res, 'Customer');
        res.json({ status: 'success', data: await accountDetail(tenant) });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.getAccount');
    }
};

/**
 * Saves the connection. The token and app secret are only required the first
 * time; left blank later they stay as they were, like the SMTP password. Meta
 * is asked about the number straight after, so a wrong ID or token shows now.
 */
const saveAccount = async (req, res) => {
    try {
        const tenant = await tenantExists(idParam(req.params.tenantId));
        if (!tenant) return notFound(res, 'Customer');

        const taken = await POSTGRESQLService.PostgresAny(
            `SELECT t.name FROM whatsapp_accounts a JOIN tenants t ON t.id = a.tenant_id
              WHERE a.phone_number_id = $1 AND a.tenant_id <> $2`,
            [req.body.phone_number_id, tenant.id]
        );
        if (taken.length) {
            return res.status(409).json({ status: 'error', message: `This WhatsApp number is already connected to ${taken[0].name}.` });
        }

        const existing = await accountRow(tenant.id);
        const { access_token: token, app_secret: secret, ...rest } = req.body;
        if (!existing && (!token || !secret)) {
            return res.status(400).json({ status: 'error', message: 'The access token and the app secret are both needed the first time.' });
        }

        const values = {
            ...rest,
            app_id: rest.app_id || null,
            notify_emails: rest.notify_emails || null,
            access_token_enc: token ? encrypt(token) : existing.access_token_enc,
            app_secret_enc: secret ? encrypt(secret) : existing.app_secret_enc,
            is_active: true,
            // New details: what Meta said about the old ones no longer counts.
            checked_at: null,
            quality_rating: null,
            updated_at: new Date()
        };
        if (existing) {
            await POSTGRESQLService.PostgresUpdate('whatsapp_accounts', values, existing.id);
        } else {
            await POSTGRESQLService.PostgresInsert('whatsapp_accounts', {
                ...values, tenant_id: tenant.id, verify_token: crypto.randomBytes(24).toString('base64url')
            });
        }
        logger.info('WhatsApp account saved', { tenantId: tenant.id, by: req.email });

        let check;
        try {
            check = { ok: true, info: await whatsapp.checkNumber(await whatsapp.accountOf(tenant.id)) };
        } catch (error) {
            check = { ok: false, message: whatsapp.explain(error) };
        }
        res.json({ status: 'success', data: await accountDetail(tenant), check });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.saveAccount');
    }
};

const checkAccount = async (req, res) => {
    try {
        const account = await whatsapp.accountOf(idParam(req.params.tenantId));
        if (!account) return res.status(400).json({ status: 'error', message: 'Connect WhatsApp for this customer first.' });
        const info = await whatsapp.checkNumber(account);
        res.json({ status: 'success', data: info });
    } catch (error) {
        logger.warn('WhatsApp check failed', { tenantId: req.params.tenantId, error: error.message });
        res.status(400).json({ status: 'error', message: whatsapp.explain(error) });
    }
};

/** Meta's ready-made hello_world template, so a brand-new number can be tested before any template is approved. */
const sendAccountTest = async (req, res) => {
    try {
        const account = await whatsapp.accountOf(idParam(req.params.tenantId));
        if (!account) return res.status(400).json({ status: 'error', message: 'Connect WhatsApp for this customer first.' });
        const to = normalisePhone((req.body || {}).to, account.default_country);
        if (!to.phone) return res.status(400).json({ status: 'error', message: `Your WhatsApp number: ${to.reason}.` });

        await whatsapp.sendTemplate(account, to.phone, {
            name: String((req.body || {}).template_name || 'hello_world'),
            language: String((req.body || {}).language || 'en_US'),
            components: []
        });
        res.json({ status: 'success', message: `Sent to ${formatPhone(to.phone)}. It should arrive in a few seconds.` });
    } catch (error) {
        logger.warn('WhatsApp test failed', { tenantId: req.params.tenantId, error: error.message });
        res.status(400).json({ status: 'error', message: whatsapp.explain(error) });
    }
};

const removeAccount = async (req, res) => {
    try {
        const tenantId = idParam(req.params.tenantId);
        const busy = await POSTGRESQLService.PostgresAny(
            `SELECT 1 FROM wa_campaigns WHERE tenant_id = $1 AND status IN ('sending', 'scheduled') LIMIT 1`, [tenantId]
        );
        if (busy.length) {
            return res.status(409).json({ status: 'error', message: 'Pause or cancel this customer\'s WhatsApp campaigns first.' });
        }
        await POSTGRESQLService.PostgresAny(`DELETE FROM whatsapp_accounts WHERE tenant_id = $1`, [tenantId]);
        logger.warn('WhatsApp account disconnected', { tenantId, by: req.email });
        res.json({ status: 'success', message: 'WhatsApp disconnected for this customer.' });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.removeAccount');
    }
};

/** A picture for a WhatsApp header, hosted like an email banner. */
const uploadImage = async (req, res) => {
    try {
        const tenant = await tenantExists(idParam(req.params.tenantId));
        if (!tenant) return notFound(res, 'Customer');
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            return res.status(400).json({ status: 'error', message: 'The picture is empty.' });
        }
        const image = await images.save({ tenantId: tenant.id, buffer: req.body });
        if (!image) return res.status(400).json({ status: 'error', message: 'Use a PNG or JPG picture.' });
        res.status(201).json({ status: 'success', data: image });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.uploadImage');
    }
};

// ------------------------------------------------------------ templates --

const listTemplates = async (req, res) => {
    try {
        const account = await whatsapp.accountOf(idParam(req.params.tenantId));
        if (!account) return res.status(400).json({ status: 'error', message: 'Connect WhatsApp for this customer first.' });
        const templates = await whatsapp.listTemplates(account);
        res.json({
            status: 'success',
            data: templates.map((t) => ({
                id: t.id,
                name: t.name,
                status: t.status,
                category: t.category,
                language: t.language,
                components: t.components || [],
                parameter_format: t.parameter_format || 'POSITIONAL',
                rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
                quality: t.quality_score && t.quality_score.score ? t.quality_score.score : null
            }))
        });
    } catch (error) {
        logger.warn('WhatsApp templates could not be listed', { tenantId: req.params.tenantId, error: error.message });
        res.status(400).json({ status: 'error', message: whatsapp.explain(error) });
    }
};

/** The header picture's bytes: ours straight from the database, anyone else's downloaded. */
async function pictureBytes(url) {
    const own = await images.loadOwn(url);
    if (own) return { content: own.content, contentType: own.content_type };
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const contentType = String(res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || !/^image\/(png|jpeg)$/.test(contentType)) throw new Error('The header picture link does not open a PNG or JPG.');
    const content = Buffer.from(await res.arrayBuffer());
    if (content.length > 5 * 1024 * 1024) throw new Error('The header picture is over 5 MB.');
    return { content, contentType };
}

/**
 * Submits a template to Meta. Variables are numbered {{1}}, {{2}}… in the
 * order they appear, each with an example, which Meta needs to approve it.
 */
const createTemplate = async (req, res) => {
    try {
        const account = await whatsapp.accountOf(idParam(req.params.tenantId));
        if (!account) return res.status(400).json({ status: 'error', message: 'Connect WhatsApp for this customer first.' });
        const t = req.body;

        const names = whatsapp.variablesIn(t.body);
        const problems = [];
        if (names.some((n, i) => n !== String(i + 1))) problems.push('Number the variables in order: {{1}}, then {{2}}, and so on.');
        if (/^\s*\{\{/.test(t.body) || /\}\}\s*$/.test(t.body)) {
            problems.push('Meta does not accept a message that starts or ends with a variable. Add a few words before or after it.');
        }
        names.forEach((n) => { if (!String((t.examples || {})[n] || '').trim()) problems.push(`Give an example for {{${n}}} — Meta needs one to approve it.`); });
        if (t.header_format === 'TEXT' && !String(t.header_text || '').trim()) problems.push('Write the header text, or choose no header.');
        if (t.header_format === 'TEXT' && /\{\{/.test(t.header_text || '')) problems.push('Keep the header text without variables.');
        if (t.header_format === 'IMAGE' && !t.header_image_url) problems.push('Upload the header picture, or choose no header.');
        if (problems.length) return res.status(400).json({ status: 'error', message: problems.join('\n') });

        const components = [];
        if (t.header_format === 'TEXT') components.push({ type: 'HEADER', format: 'TEXT', text: t.header_text.trim() });
        if (t.header_format === 'IMAGE') {
            const picture = await pictureBytes(t.header_image_url);
            const handle = await whatsapp.uploadExample(account, picture.content, picture.contentType);
            components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } });
        }
        components.push({
            type: 'BODY',
            text: t.body,
            ...(names.length ? { example: { body_text: [names.map((n) => String(t.examples[n]).trim())] } } : {})
        });
        if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
        if (t.buttons.length) {
            // Meta wants the quick replies together, before the link and call buttons.
            const order = { QUICK_REPLY: 0, URL: 1, PHONE_NUMBER: 2 };
            const buttons = [...t.buttons].sort((a, b) => order[a.type] - order[b.type]).map((b) => (
                b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url }
                    : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number }
                        : { type: 'QUICK_REPLY', text: b.text }
            ));
            components.push({ type: 'BUTTONS', buttons });
        }

        const created = await whatsapp.createTemplate(account, {
            name: t.name, category: t.category, language: t.language, components
        });
        logger.info('WhatsApp template submitted', { tenantId: account.tenant_id, name: t.name, status: created.status, by: req.email });
        res.status(201).json({
            status: 'success',
            message: created.status === 'APPROVED'
                ? 'Approved by Meta already — you can use it now.'
                : 'Sent to Meta for approval. It usually takes a few minutes; press Refresh to see.',
            data: { id: created.id, status: created.status, category: created.category }
        });
    } catch (error) {
        logger.warn('WhatsApp template not created', { tenantId: req.params.tenantId, error: error.message });
        const message = error instanceof whatsapp.WhatsAppError ? whatsapp.explain(error) : error.message;
        res.status(400).json({ status: 'error', message });
    }
};

// ------------------------------------------------------------ campaigns --

async function loadCampaign(id) {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT c.*, t.name AS tenant_name FROM wa_campaigns c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = $1`, [id]
    );
    return rows[0] || null;
}

async function statsFor(ids) {
    if (!ids.length) return new Map();
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT campaign_id,
                count(*)::int AS total,
                count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'sending')::int AS sending,
                count(*) FILTER (WHERE status IN ('sent', 'delivered', 'read'))::int AS sent,
                count(*) FILTER (WHERE status IN ('delivered', 'read'))::int AS delivered,
                count(*) FILTER (WHERE status = 'read')::int AS read,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
           FROM wa_recipients
          WHERE campaign_id = ANY($1::int[])
          GROUP BY campaign_id`,
        [ids]
    );
    return new Map(rows.map(({ campaign_id: campaignId, ...stats }) => [campaignId, stats]));
}

async function statsOf(id) {
    return (await statsFor([id])).get(id) || EMPTY_STATS;
}

function attempted(stats) {
    return stats.sent + stats.failed + stats.sending;
}

function campaignColumns(body) {
    return {
        tenant_id: body.tenant_id,
        name: body.name,
        template_name: body.template_name || null,
        template_language: body.template_language || null,
        template_category: body.template_category || null,
        template_format: body.template_format || null,
        template_components: body.template_components ? JSON.stringify(body.template_components) : null,
        variables: JSON.stringify(body.variables || {}),
        header_media_url: body.header_media_url || null,
        send_window: body.send_window ? JSON.stringify(body.send_window) : null
    };
}

const getAll = async (req, res) => {
    try {
        const conditions = [];
        const params = [];
        const tenantId = idParam(req.query.tenant_id);
        if (tenantId) { params.push(tenantId); conditions.push(`c.tenant_id = $${params.length}`); }
        if (req.query.status) { params.push(String(req.query.status)); conditions.push(`c.status = $${params.length}`); }
        if (req.query.search) {
            params.push(`%${req.query.search}%`);
            conditions.push(`(c.name ILIKE $${params.length} OR c.template_name ILIKE $${params.length})`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT c.id, c.tenant_id, c.name, c.status, c.template_name, c.status_reason, c.scheduled_at, c.next_send_at,
                    c.started_at, c.completed_at, c.created_at, c.updated_at, t.name AS tenant_name, a.display_phone
               FROM wa_campaigns c
               JOIN tenants t ON t.id = c.tenant_id
               LEFT JOIN whatsapp_accounts a ON a.tenant_id = c.tenant_id
               ${where}
              ORDER BY c.created_at DESC
              LIMIT 500`,
            params
        );
        const stats = await statsFor(rows.map((r) => r.id));
        res.json({ status: 'success', data: rows.map((r) => ({ ...r, stats: stats.get(r.id) || EMPTY_STATS })) });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.getAll');
    }
};

const getOne = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        const [stats, account, status] = await Promise.all([statsOf(id), accountRow(row.tenant_id), pace.status(row.tenant_id)]);
        res.json({
            status: 'success',
            data: {
                ...row,
                stats,
                account: account ? { connected: true, ...presentAccount(account) } : { connected: false },
                pace: status,
                editable: {
                    content: EDITABLE.includes(row.status),
                    recipients: EDITABLE.includes(row.status) && attempted(stats) === 0
                }
            }
        });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.getOne');
    }
};

const create = async (req, res) => {
    try {
        if (!await tenantExists(req.body.tenant_id)) return res.status(400).json({ status: 'error', message: 'Customer not found.' });
        const row = await POSTGRESQLService.PostgresInsert('wa_campaigns', campaignColumns(req.body));
        logger.info('WhatsApp campaign created', { id: row.id, tenantId: row.tenant_id, by: req.email });
        res.status(201).json({ status: 'success', data: row });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.create');
    }
};

const update = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (!EDITABLE.includes(row.status)) {
            return res.status(409).json({
                status: 'error',
                message: row.status === 'sending' ? 'Pause the campaign before changing it.' : 'A finished campaign cannot be changed. Duplicate it instead.'
            });
        }
        if (req.body.tenant_id !== row.tenant_id && attempted(await statsOf(id)) > 0) {
            return res.status(409).json({ status: 'error', message: 'The WhatsApp number cannot change once messages have gone out.' });
        }
        const data = await POSTGRESQLService.PostgresUpdate('wa_campaigns', { ...campaignColumns(req.body), updated_at: new Date() }, id);
        res.json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.update');
    }
};

const remove = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (row.status === 'sending') return res.status(409).json({ status: 'error', message: 'Pause or cancel the campaign before deleting it.' });
        await POSTGRESQLService.PostgresDelete('wa_campaigns', 'id', id);
        logger.warn('WhatsApp campaign deleted', { id, by: req.email });
        res.json({ status: 'success', message: 'Campaign deleted.' });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.remove');
    }
};

/** Same template and settings as a new draft; the list stays behind, as for email. */
const duplicate = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        if (!id || !await loadCampaign(id)) return notFound(res);
        const rows = await POSTGRESQLService.PostgresAny(
            `INSERT INTO wa_campaigns (tenant_id, name, template_name, template_language, template_category,
                                       template_components, template_format, variables, header_media_url, send_window)
             SELECT tenant_id, left(name || ' (copy)', 150), template_name, template_language, template_category,
                    template_components, template_format, variables, header_media_url, send_window
               FROM wa_campaigns WHERE id = $1
             RETURNING *`,
            [id]
        );
        res.status(201).json({ status: 'success', message: 'Copied as a new draft. Upload a contact list to send it.', data: rows[0] });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.duplicate');
    }
};

// ------------------------------------------------------------- contacts --

const uploadRecipients = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (!EDITABLE.includes(row.status) || attempted(await statsOf(id)) > 0) {
            return res.status(409).json({ status: 'error', message: 'The list cannot change once sending has started. Duplicate the campaign to send to a new list.' });
        }
        if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ status: 'error', message: 'Choose a CSV file to upload.' });

        const account = await accountRow(row.tenant_id);
        const country = account ? account.default_country : '91';
        const parsed = parsePhoneList(req.body, country);
        if (parsed.error) return res.status(400).json({ status: 'error', message: parsed.error });

        const phones = parsed.rows.map((r) => r.phone);
        const blocked = phones.length
            ? await POSTGRESQLService.PostgresAny(
                `SELECT phone FROM wa_optouts WHERE tenant_id = $1 AND phone = ANY($2::text[])`, [row.tenant_id, phones]
            )
            : [];
        const suppressed = new Set(blocked.map((r) => r.phone));
        const rows = parsed.rows.filter((r) => !suppressed.has(r.phone));

        const summary = {
            filename: String(req.query.filename || '').replace(/[^\w .()-]+/g, '').slice(0, 150) || null,
            total_rows: parsed.total_rows,
            imported: rows.length,
            invalid_count: parsed.invalid_count,
            invalid: parsed.invalid,
            duplicates: parsed.duplicates,
            suppressed: suppressed.size,
            country,
            columns: parsed.columns
        };

        await POSTGRESQLService.PostgresTransaction(async (client) => {
            await client.query(`DELETE FROM wa_recipients WHERE campaign_id = $1`, [id]);
            for (let i = 0; i < rows.length; i += 2000) {
                const chunk = rows.slice(i, i + 2000);
                // In file order: the list goes out top to bottom.
                await client.query(
                    `INSERT INTO wa_recipients (campaign_id, phone, data)
                     SELECT $1::int, p, d::jsonb FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS x(p, d, n)
                      ORDER BY n`,
                    [id, chunk.map((r) => r.phone), chunk.map((r) => JSON.stringify(r.data))]
                );
            }
            await client.query(
                `UPDATE wa_campaigns SET columns = $2, import_summary = $3, updated_at = now() WHERE id = $1`,
                [id, summary.columns, JSON.stringify(summary)]
            );
        });

        logger.info('WhatsApp contacts uploaded', { id, imported: rows.length, invalid: parsed.invalid_count, by: req.email });
        res.json({ status: 'success', data: summary });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.uploadRecipients');
    }
};

const listRecipients = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        if (!id) return notFound(res);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

        const params = [id];
        const conditions = ['r.campaign_id = $1'];
        const filter = RECIPIENT_FILTERS.get(String(req.query.status || ''));
        if (filter) conditions.push(filter);
        if (req.query.search) {
            params.push(`%${String(req.query.search).replace(/[\s+()-]/g, '')}%`, `%${req.query.search}%`);
            conditions.push(`(r.phone LIKE $${params.length - 1} OR r.data::text ILIKE $${params.length})`);
        }
        const where = `WHERE ${conditions.join(' AND ')}`;
        const total = await POSTGRESQLService.PostgresAny(`SELECT count(*)::int AS total FROM wa_recipients r ${where}`, params);

        params.push(limit, (page - 1) * limit);
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT r.id, r.phone, r.data, r.status, r.error, r.attempted_at, r.sent_at, r.delivered_at, r.read_at, r.replied_at
               FROM wa_recipients r ${where}
              ORDER BY r.id
              LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        res.json({
            status: 'success',
            data: data.map((r) => ({ ...r, phone_display: formatPhone(r.phone) })),
            pagination: { page, limit, total: total[0].total, pages: Math.ceil(total[0].total / limit) }
        });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.listRecipients');
    }
};

const removeRecipient = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const recipientId = idParam(req.params.recipientId);
        if (!id || !await loadCampaign(id)) return notFound(res);
        const removed = recipientId
            ? await POSTGRESQLService.PostgresAny(
                `DELETE FROM wa_recipients WHERE id = $1 AND campaign_id = $2 AND status IN ('pending', 'failed') RETURNING phone`,
                [recipientId, id]
            )
            : [];
        if (!removed.length) {
            const found = recipientId
                ? await POSTGRESQLService.PostgresAny(`SELECT status FROM wa_recipients WHERE id = $1 AND campaign_id = $2`, [recipientId, id])
                : [];
            if (!found.length) return notFound(res, 'Contact');
            return res.status(409).json({
                status: 'error',
                message: found[0].status === 'sending' ? 'Their message is being sent right now.' : 'Their message has already been sent or skipped, so they stay in the report.'
            });
        }
        res.json({ status: 'success', message: `${formatPhone(removed[0].phone)} removed — they won't get this campaign.` });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.removeRecipient');
    }
};

const clearRecipients = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (!EDITABLE.includes(row.status) || attempted(await statsOf(id)) > 0) {
            return res.status(409).json({ status: 'error', message: 'The list cannot change once sending has started.' });
        }
        await POSTGRESQLService.PostgresAny(`DELETE FROM wa_recipients WHERE campaign_id = $1`, [id]);
        await POSTGRESQLService.PostgresAny(`UPDATE wa_campaigns SET columns = '{}', import_summary = NULL, updated_at = now() WHERE id = $1`, [id]);
        res.json({ status: 'success', message: 'Contact list cleared.' });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.clearRecipients');
    }
};

const exportRecipients = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT phone, data, status, error, sent_at, delivered_at, read_at, replied_at FROM wa_recipients WHERE campaign_id = $1 ORDER BY id`,
            [id]
        );
        const dataKeys = [...new Set(rows.flatMap((r) => Object.keys(r.data || {})))].filter((k) => k !== 'phone');
        const header = ['phone', 'status', 'sent_at', 'delivered_at', 'read_at', 'replied_at', 'error', ...dataKeys];
        const cell = (v) => {
            let s = v === null || v === undefined ? '' : (v instanceof Date ? v.toISOString() : String(v));
            if (/^[=+\-@]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
        };
        const lines = [header.map(cell).join(',')];
        for (const r of rows) {
            // Without the "+": Excel reads a cell starting with + as a formula.
            lines.push([formatPhone(r.phone).replace(/^\+/, ''), r.status, r.sent_at, r.delivered_at, r.read_at, r.replied_at, r.error,
                ...dataKeys.map((k) => (r.data || {})[k])].map(cell).join(','));
        }
        const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'whatsapp';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${slug}-results.csv"`);
        res.send('﻿' + lines.join('\n'));
    } catch (error) {
        handleServerError(res, error, 'whatsapp.exportRecipients');
    }
};

// -------------------------------------------------------------- sending --

/** The template as the editor has it now, for a test before anything is saved. */
function draftOf(row, body) {
    // eslint-disable-next-line no-unused-vars
    const { to, tenant_id: tenantId, name, ...fields } = body || {};
    return { ...row, ...fields };
}

const sendTest = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        const account = await whatsapp.accountOf(row.tenant_id);
        if (!account) return res.status(400).json({ status: 'error', message: 'Connect WhatsApp for this customer first.' });

        const draft = draftOf(row, req.body);
        if (!draft.template_name) return res.status(400).json({ status: 'error', message: 'Choose a template first.' });
        const to = normalisePhone(req.body.to, account.default_country);
        if (!to.phone) return res.status(400).json({ status: 'error', message: `Your WhatsApp number: ${to.reason}.` });

        const first = await POSTGRESQLService.PostgresAny(
            `SELECT phone, data FROM wa_recipients WHERE campaign_id = $1 ORDER BY id LIMIT 1`, [id]
        );
        const data = first.length ? { ...first[0].data, phone: first[0].phone } : { first_name: 'Priya', company: 'Acme Textiles' };
        const { components, missing } = whatsapp.buildComponents(draft, data);
        if (missing.length) return res.status(400).json({ status: 'error', message: `Fill in ${missing.join(', ')} first.` });

        await whatsapp.sendTemplate(account, to.phone, { name: draft.template_name, language: draft.template_language, components });
        res.json({ status: 'success', message: `Test sent to ${formatPhone(to.phone)}${first.length ? `, filled in as ${formatPhone(first[0].phone)}` : ''}.` });
    } catch (error) {
        logger.warn('WhatsApp campaign test failed', { id: req.params.id, error: error.message });
        res.status(400).json({ status: 'error', message: whatsapp.explain(error) });
    }
};

/** Starts, resumes or schedules — after checking everything that would make WhatsApp refuse the messages. */
const start = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (!EDITABLE.includes(row.status)) {
            return res.status(409).json({
                status: 'error',
                message: row.status === 'sending' ? 'This campaign is already sending.' : 'A finished campaign cannot start again. Duplicate it, or retry its failed messages.'
            });
        }

        const account = await whatsapp.accountOf(row.tenant_id);
        if (!account) return res.status(400).json({ status: 'error', message: `Connect WhatsApp for ${row.tenant_name} first.` });
        if (!row.template_name) return res.status(400).json({ status: 'error', message: 'Choose an approved template in step 2.' });
        if (!req.body || req.body.consent !== true) {
            return res.status(400).json({ status: 'error', message: 'Confirm that these contacts know your business and expect to hear from you.' });
        }

        // Meta's word, not the saved copy: the template may have been paused or edited since.
        let template;
        try {
            template = (await whatsapp.listTemplates(account)).find((t) => t.name === row.template_name && t.language === row.template_language);
        } catch (error) {
            return res.status(400).json({ status: 'error', message: whatsapp.explain(error) });
        }
        if (!template) return res.status(400).json({ status: 'error', message: `Meta has no template "${row.template_name}" in this language any more. Choose another in step 2.` });
        if (template.status !== 'APPROVED') {
            return res.status(400).json({ status: 'error', message: `The template "${row.template_name}" is ${String(template.status).toLowerCase()} — it can be sent once Meta approves it.` });
        }
        const fresh = { ...row, template_components: template.components, template_format: template.parameter_format || 'POSITIONAL' };

        const stats = await statsOf(id);
        if (!stats.pending) {
            return res.status(400).json({ status: 'error', message: stats.failed ? 'Nothing is waiting. Use "Retry failed" to try the failed ones again.' : 'Upload the contact list in step 3.' });
        }

        // Every waiting contact must fill every variable, or WhatsApp refuses that message.
        const pending = await POSTGRESQLService.PostgresAny(`SELECT phone, data FROM wa_recipients WHERE campaign_id = $1 AND status = 'pending'`, [id]);
        const gaps = new Map();
        for (const r of pending) {
            for (const slot of whatsapp.buildComponents(fresh, { ...r.data, phone: r.phone }).missing) gaps.set(slot, (gaps.get(slot) || 0) + 1);
        }
        if (gaps.size) {
            const lines = [...gaps].map(([slot, n]) => `${slot} comes out empty for ${n} contact(s)`);
            return res.status(400).json({ status: 'error', message: `${lines.join('\n')}\nGive each one a fallback in step 2, e.g. {{company|your company}}.` });
        }

        try {
            if ((await whatsapp.checkNumber(account)).quality_rating === 'RED') {
                return res.status(400).json({ status: 'error', message: 'WhatsApp rates this number\'s quality as Low right now. Wait until it recovers before sending more.' });
            }
        } catch (error) {
            return res.status(400).json({ status: 'error', message: whatsapp.explain(error) });
        }

        let scheduledAt = null;
        if (req.body.scheduled_at) {
            const when = new Date(req.body.scheduled_at);
            if (Number.isNaN(when.getTime())) return res.status(400).json({ status: 'error', message: 'Choose a valid date and time.' });
            if (when.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ status: 'error', message: 'That time has already passed.' });
            if (when.getTime() > Date.now() + 30 * 1000) scheduledAt = when;
        }

        await POSTGRESQLService.PostgresAny(
            `UPDATE wa_campaigns
                SET template_components = $2, template_format = $3, template_category = $4,
                    status = $5, scheduled_at = $6, next_send_at = CASE WHEN $5 = 'sending' THEN now() END,
                    started_at = CASE WHEN $5 = 'sending' THEN COALESCE(started_at, now()) ELSE started_at END,
                    status_reason = NULL, retry_count = 0, completed_at = NULL, updated_at = now()
              WHERE id = $1`,
            [id, JSON.stringify(template.components), fresh.template_format, template.category,
                scheduledAt ? 'scheduled' : 'sending', scheduledAt]
        );
        logger.info(scheduledAt ? 'WhatsApp campaign scheduled' : 'WhatsApp campaign started', { id, contacts: stats.pending, by: req.email });
        res.json({
            status: 'success',
            message: scheduledAt ? 'Campaign scheduled.' : `Sending to ${stats.pending} contact(s) has started — ${pace.describe()} from this number`
                + `${row.send_window ? `, ${sendWindow.describe(row.send_window)}` : ''}.`
        });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.start');
    }
};

const pause = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (row.status === 'sending') {
            await POSTGRESQLService.PostgresAny(
                `UPDATE wa_campaigns SET status = 'paused', next_send_at = NULL, status_reason = NULL, updated_at = now() WHERE id = $1 AND status = 'sending'`, [id]
            );
            return res.json({ status: 'success', message: 'Paused. Resume whenever you are ready.' });
        }
        if (row.status === 'scheduled') {
            const next = attempted(await statsOf(id)) > 0 ? 'paused' : 'draft';
            await POSTGRESQLService.PostgresAny(`UPDATE wa_campaigns SET status = $2, scheduled_at = NULL, updated_at = now() WHERE id = $1`, [id, next]);
            return res.json({ status: 'success', message: 'Unscheduled. Nothing is sent until you start it again.' });
        }
        res.status(409).json({ status: 'error', message: 'Only a sending or scheduled campaign can be paused.' });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.pause');
    }
};

const cancel = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (!['sending', 'paused', 'scheduled'].includes(row.status)) {
            return res.status(409).json({ status: 'error', message: 'Only a sending, paused or scheduled campaign can be cancelled.' });
        }
        await POSTGRESQLService.PostgresAny(
            `UPDATE wa_campaigns SET status = 'cancelled', next_send_at = NULL, scheduled_at = NULL, status_reason = NULL,
                    completed_at = now(), updated_at = now() WHERE id = $1`, [id]
        );
        res.json({ status: 'success', message: 'Cancelled. Nothing more will be sent.' });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.cancel');
    }
};

const retryFailed = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (!['completed', 'paused'].includes(row.status)) {
            return res.status(409).json({ status: 'error', message: 'Failed messages can be retried once the campaign has finished, or while it is paused.' });
        }
        const reset = await POSTGRESQLService.PostgresAny(
            `UPDATE wa_recipients SET status = 'pending', error = NULL, attempted_at = NULL, wa_message_id = NULL
              WHERE campaign_id = $1 AND status = 'failed' RETURNING id`, [id]
        );
        if (!reset.length) return res.status(400).json({ status: 'error', message: 'There are no failed messages to retry.' });
        if (row.status === 'completed') {
            await POSTGRESQLService.PostgresAny(
                `UPDATE wa_campaigns SET status = 'sending', completed_at = NULL, next_send_at = now(), retry_count = 0,
                        status_reason = NULL, updated_at = now() WHERE id = $1`, [id]
            );
        }
        res.json({ status: 'success', message: `${reset.length} message(s) queued again.${row.status === 'paused' ? ' Resume the campaign to send them.' : ''}` });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.retryFailed');
    }
};

/**
 * Sending hours can change at any time, even mid-send: they only decide when
 * the next turn is, never how many go out. A sending campaign looks again at once.
 */
const setSendWindow = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        if (!['draft', 'scheduled', 'sending', 'paused'].includes(row.status)) {
            return res.status(409).json({ status: 'error', message: 'A finished campaign has no sending hours to change.' });
        }
        const window = req.body.send_window;
        const rows = await POSTGRESQLService.PostgresAny(
            `UPDATE wa_campaigns
                SET send_window = $2, updated_at = now(),
                    next_send_at = CASE WHEN status = 'sending' THEN now() ELSE next_send_at END
              WHERE id = $1
            RETURNING send_window`,
            [id, window ? JSON.stringify(window) : null]
        );
        logger.info('Sending hours changed', { id, window: sendWindow.describe(window), by: req.email });
        res.json({
            status: 'success',
            message: window ? `Sending hours set: ${sendWindow.describe(window)}.` : 'Sends at any time now.',
            data: rows[0]
        });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.setSendWindow');
    }
};

// -------------------------------------------------------------- replies --

/** Everyone who wrote back after this campaign, with the whole thread. */
const conversations = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        const threads = await POSTGRESQLService.PostgresAny(
            `SELECT m.phone,
                    json_agg(json_build_object('id', m.id, 'direction', m.direction, 'body', m.body, 'created_at', m.created_at)
                             ORDER BY m.created_at) AS messages,
                    max(m.created_at) FILTER (WHERE m.direction = 'in') AS last_in,
                    max(m.created_at) AS last_at,
                    (SELECT r.data FROM wa_recipients r WHERE r.campaign_id = $1 AND r.phone = m.phone LIMIT 1) AS data,
                    EXISTS (SELECT 1 FROM wa_optouts o WHERE o.tenant_id = $2 AND o.phone = m.phone) AS opted_out
               FROM wa_messages m
              WHERE m.tenant_id = $2 AND m.phone IN (SELECT phone FROM wa_messages WHERE campaign_id = $1 AND direction = 'in')
              GROUP BY m.phone
              ORDER BY max(m.created_at) DESC
              LIMIT 200`,
            [id, row.tenant_id]
        );
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        res.json({
            status: 'success',
            data: threads.map((t) => ({
                ...t,
                phone_display: formatPhone(t.phone),
                data: t.data || {},
                can_reply: Boolean(t.last_in) && new Date(t.last_in).getTime() > dayAgo
            }))
        });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.conversations');
    }
};

/** A free reply — WhatsApp allows it for 24 hours after the person's last message. */
const reply = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);
        const phone = String(req.params.phone || '').replace(/\D/g, '');
        const last = await POSTGRESQLService.PostgresAny(
            `SELECT max(created_at) AS at FROM wa_messages WHERE tenant_id = $1 AND phone = $2 AND direction = 'in'`, [row.tenant_id, phone]
        );
        if (!last[0].at || Date.now() - new Date(last[0].at).getTime() > 24 * 60 * 60 * 1000) {
            return res.status(400).json({ status: 'error', message: 'WhatsApp allows a free reply only within 24 hours of their last message. Call them, or send a new campaign.' });
        }
        const account = await whatsapp.accountOf(row.tenant_id);
        if (!account) return res.status(400).json({ status: 'error', message: 'Connect WhatsApp for this customer first.' });

        const messageId = await whatsapp.sendText(account, phone, req.body.text);
        await POSTGRESQLService.PostgresAny(
            `INSERT INTO wa_messages (tenant_id, campaign_id, phone, direction, body, wa_message_id) VALUES ($1, $2, $3, 'out', $4, $5)`,
            [row.tenant_id, id, phone, req.body.text, messageId || null]
        );
        res.json({ status: 'success', message: `Reply sent to ${formatPhone(phone)}.` });
    } catch (error) {
        logger.warn('WhatsApp reply failed', { id: req.params.id, error: error.message });
        res.status(400).json({ status: 'error', message: whatsapp.explain(error) });
    }
};

// ----------------------------------------------------- do-not-message list --

const listOptouts = async (req, res) => {
    try {
        const tenantId = idParam(req.query.tenant_id);
        if (!tenantId) return res.status(400).json({ status: 'error', message: 'Choose a customer.' });
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT o.id, o.phone, o.source, o.created_at, c.name AS campaign_name
               FROM wa_optouts o LEFT JOIN wa_campaigns c ON c.id = o.campaign_id
              WHERE o.tenant_id = $1 ORDER BY o.created_at DESC LIMIT 5000`,
            [tenantId]
        );
        res.json({ status: 'success', data: data.map((o) => ({ ...o, phone_display: formatPhone(o.phone) })) });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.listOptouts');
    }
};

const addOptouts = async (req, res) => {
    try {
        const tenantId = req.body.tenant_id;
        if (!await tenantExists(tenantId)) return res.status(400).json({ status: 'error', message: 'Customer not found.' });
        const account = await accountRow(tenantId);
        const country = account ? account.default_country : '91';
        const phones = [...new Set(String(req.body.phones).split(/[\n,;]+/).map((p) => normalisePhone(p, country).phone).filter(Boolean))];
        if (!phones.length) return res.status(400).json({ status: 'error', message: 'No mobile numbers found. Put one per line.' });
        const added = await POSTGRESQLService.PostgresAny(
            `INSERT INTO wa_optouts (tenant_id, phone, source)
             SELECT $1, p, 'manual' FROM unnest($2::text[]) AS p
             ON CONFLICT (tenant_id, phone) DO NOTHING RETURNING id`,
            [tenantId, phones]
        );
        res.json({ status: 'success', message: `${added.length} number(s) added. They will not get WhatsApp campaigns from this customer.` });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.addOptouts');
    }
};

const removeOptout = async (req, res) => {
    try {
        const deleted = await POSTGRESQLService.PostgresAny(`DELETE FROM wa_optouts WHERE id = $1 RETURNING id`, [idParam(req.params.optoutId)]);
        if (!deleted.length) return notFound(res, 'Number');
        res.json({ status: 'success', message: 'Removed from the do-not-message list.' });
    } catch (error) {
        handleServerError(res, error, 'whatsapp.removeOptout');
    }
};

module.exports = {
    listAccounts, getAccount, saveAccount, checkAccount, sendAccountTest, removeAccount, uploadImage,
    listTemplates, createTemplate,
    getAll, getOne, create, update, remove, duplicate,
    uploadRecipients, listRecipients, removeRecipient, clearRecipients, exportRecipients,
    sendTest, start, pause, cancel, retryFailed, setSendWindow,
    conversations, reply,
    listOptouts, addOptouts, removeOptout
};
