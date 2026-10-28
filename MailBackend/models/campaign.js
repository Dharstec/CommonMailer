/**
 * Campaigns, admin side: write one message, upload a list, send it to everyone
 * from the customer's own mailbox, and watch the results come in.
 *
 * These handlers only move a campaign between states. The sending itself is
 * done by helpers/campaignWorker.js, which notices on its next tick:
 *
 *   draft      being written; the list and attachments can still change
 *   scheduled  waiting for scheduled_at; still editable
 *   sending    the worker is working through the queue
 *   paused     stopped by you, or by the worker — status_reason says why
 *   completed  nothing left in the queue (failed rows can be retried)
 *   cancelled  stopped for good
 */
const crypto = require('crypto');
const POSTGRESQLService = require('../helpers/POSTGRES');
const mailer = require('../helpers/mailer');
const { parseRecipients, isEmail, cleanEmail } = require('../helpers/campaignCsv');
const {
    renderCampaign, formatBytes, mailAttachments, inlinePreviewImages, missingInlineImages
} = require('../helpers/campaignRender');
const { baseUrl } = require('../helpers/links');
const { explainSmtpError } = require('../helpers/smtpErrors');
const logger = require('../helpers/logger');

const handleServerError = (res, error, where) => {
    logger.error(`${where} failed`, { error: error.message, stack: error.stack });
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};

/** States in which the message may still be edited. */
const EDITABLE = ['draft', 'scheduled', 'paused'];

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Under nginx's 30 s proxy_read_timeout, with room to answer before it gives up. */
const TEST_REPLY_WAIT_MS = 25 * 1000;

/**
 * Gmail and Outlook refuse mail carrying these outright — the message bounces
 * for every recipient — so they are stopped at upload rather than mid-send.
 */
const BLOCKED_EXTENSIONS = new Set([
    'ade', 'adp', 'apk', 'appx', 'bat', 'cab', 'chm', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'exe', 'hta',
    'img', 'ins', 'iso', 'isp', 'jar', 'jnlp', 'js', 'jse', 'lib', 'lnk', 'mde', 'msc', 'msi', 'msix',
    'msp', 'mst', 'nsh', 'pif', 'ps1', 'scr', 'sct', 'shb', 'sys', 'vb', 'vbe', 'vbs', 'vhd', 'vxd',
    'wsc', 'wsf', 'wsh', 'xll'
]);

/** Used for previews until a list has been uploaded. */
const SAMPLE_RECIPIENT = {
    email: 'priya@example.com', first_name: 'Priya', last_name: 'Raman', name: 'Priya Raman', company: 'Acme Textiles'
};

const EMPTY_STATS = { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, opened: 0, unsubscribed: 0 };

/** Report filters. A Map, so a query string can never reach Object.prototype. */
const RECIPIENT_FILTERS = new Map([
    ['pending', `r.status = 'pending'`],
    ['sending', `r.status = 'sending'`],
    ['sent', `r.status = 'sent'`],
    ['failed', `r.status = 'failed'`],
    ['skipped', `r.status = 'skipped'`],
    ['opened', 'r.opened_at IS NOT NULL'],
    ['unsubscribed', 'r.unsubscribed_at IS NOT NULL']
]);

function idParam(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function notFound(res) {
    return res.status(404).json({ status: 'error', message: 'Campaign not found' });
}

function newToken() {
    return crypto.randomBytes(18).toString('base64url');
}

/** Unsubscribe links in previews and tests point here; the page explains they do nothing. */
function previewUnsubscribeUrl() {
    return `${baseUrl()}/api/c/preview/unsubscribe`;
}

/** Keeps the name a recipient will see, minus anything that could act as a path. */
function cleanFilename(value) {
    return String(value || '')
        .normalize('NFC')
        .replace(/[\\/]+/g, '_')
        .replace(/[\u0000-\u001f\u007f"<>|?*:]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .slice(-150);
}

/** Columns of `campaigns` that a create or update owns. */
function campaignColumns(body) {
    return {
        tenant_id: body.tenant_id,
        name: body.name,
        from_name: body.from_name || null,
        from_email: body.from_email || null,
        reply_to: body.reply_to || null,
        subject: body.subject || '',
        preheader: body.preheader || null,
        design: body.design,
        content: JSON.stringify(body.content || {}),
        custom_html: body.custom_html || null,
        track_opens: body.track_opens,
        rate_per_minute: body.rate_per_minute,
        daily_limit: body.daily_limit
    };
}

async function loadCampaign(id) {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT c.*, t.name AS tenant_name,
                (s.id IS NOT NULL AND s.is_active) AS smtp_ready,
                s.verified_at AS smtp_verified_at,
                s.from_name AS smtp_from_name,
                s.from_email AS smtp_from_email,
                s.reply_to AS smtp_reply_to,
                s.host AS smtp_host
           FROM campaigns c
           JOIN tenants t ON t.id = c.tenant_id
           LEFT JOIN tenant_smtp s ON s.tenant_id = c.tenant_id
          WHERE c.id = $1`,
        [id]
    );
    return rows[0] || null;
}

/** Recipient counters for several campaigns in one query. */
async function statsFor(ids) {
    if (!ids.length) return new Map();
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT campaign_id,
                count(*)::int AS total,
                count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'sending')::int AS sending,
                count(*) FILTER (WHERE status = 'sent')::int AS sent,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
                count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed
           FROM campaign_recipients
          WHERE campaign_id = ANY($1::int[])
          GROUP BY campaign_id`,
        [ids]
    );
    return new Map(rows.map(({ campaign_id: campaignId, ...stats }) => [campaignId, stats]));
}

async function statsOf(id) {
    return (await statsFor([id])).get(id) || EMPTY_STATS;
}

/** Messages that have been, or are being, handed to the mail server. */
function attempted(stats) {
    return stats.sent + stats.failed + stats.sending;
}

async function listAttachments(campaignId) {
    return POSTGRESQLService.PostgresAny(
        `SELECT id, filename, content_type, size_bytes, created_at
           FROM campaign_attachments WHERE campaign_id = $1 ORDER BY id`,
        [campaignId]
    );
}

/** The campaign as the panel sees it: the row, its counters, and what may still change. */
function present(row, stats, attachments) {
    const campaign = { ...row };
    ['smtp_ready', 'smtp_verified_at', 'smtp_from_name', 'smtp_from_email', 'smtp_reply_to', 'smtp_host']
        .forEach((key) => delete campaign[key]);

    return {
        ...campaign,
        stats,
        attachments,
        sender: {
            configured: Boolean(row.smtp_ready),
            verified: Boolean(row.smtp_verified_at),
            from_name: row.smtp_from_name || null,
            from_email: row.smtp_from_email || null,
            reply_to: row.smtp_reply_to || null
        },
        editable: {
            content: EDITABLE.includes(row.status),
            recipients: EDITABLE.includes(row.status) && attempted(stats) === 0
        }
    };
}

/** The saved campaign with the editor's unsaved fields laid over it. */
function draftOf(row, body) {
    // eslint-disable-next-line no-unused-vars
    const { recipient_id: recipientId, to, tenant_id: tenantId, name, ...fields } = body || {};
    return { ...row, ...fields };
}

/** Who a preview or test is personalised as: the chosen row, the first row, or a sample. */
async function pickRecipient(campaignId, recipientId) {
    const params = [campaignId];
    let where = 'campaign_id = $1';
    if (idParam(recipientId)) {
        params.push(idParam(recipientId));
        where += ' AND id = $2';
    }
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT id, email, data FROM campaign_recipients WHERE ${where} ORDER BY id LIMIT 1`,
        params
    );
    if (rows.length) return { id: rows[0].id, data: { ...rows[0].data, email: rows[0].email }, sample: false };
    return { id: null, data: SAMPLE_RECIPIENT, sample: true };
}

function listLockedMessage() {
    return 'The list cannot change once sending has started. Duplicate the campaign to send to a new list.';
}

// ------------------------------------------------------------- campaigns --

const getAll = async (req, res) => {
    try {
        const conditions = [];
        const params = [];
        const tenantId = idParam(req.query.tenant_id);
        if (tenantId) { params.push(tenantId); conditions.push(`c.tenant_id = $${params.length}`); }
        if (req.query.status) { params.push(String(req.query.status)); conditions.push(`c.status = $${params.length}`); }
        if (req.query.search) {
            params.push(`%${req.query.search}%`);
            conditions.push(`(c.name ILIKE $${params.length} OR c.subject ILIKE $${params.length})`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT c.id, c.tenant_id, c.name, c.status, c.subject, c.design, c.status_reason,
                    c.scheduled_at, c.next_send_at, c.started_at, c.completed_at, c.created_at, c.updated_at,
                    t.name AS tenant_name
               FROM campaigns c
               JOIN tenants t ON t.id = c.tenant_id
               ${where}
              ORDER BY c.created_at DESC
              LIMIT 500`,
            params
        );
        const stats = await statsFor(rows.map((r) => r.id));

        res.json({ status: 'success', data: rows.map((r) => ({ ...r, stats: stats.get(r.id) || EMPTY_STATS })) });
    } catch (error) {
        handleServerError(res, error, 'campaign.getAll');
    }
};

const getOne = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        const [stats, attachments] = await Promise.all([statsOf(id), listAttachments(id)]);
        res.json({ status: 'success', data: present(row, stats, attachments) });
    } catch (error) {
        handleServerError(res, error, 'campaign.getOne');
    }
};

const create = async (req, res) => {
    try {
        const tenant = await POSTGRESQLService.PostgresAny(`SELECT id FROM tenants WHERE id = $1`, [req.body.tenant_id]);
        if (!tenant.length) return res.status(400).json({ status: 'error', message: 'Customer not found.' });

        const row = await POSTGRESQLService.PostgresInsert('campaigns', campaignColumns(req.body));
        logger.info('Campaign created', { id: row.id, tenantId: row.tenant_id, by: req.email });
        res.status(201).json({ status: 'success', data: row });
    } catch (error) {
        handleServerError(res, error, 'campaign.create');
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
                message: row.status === 'sending'
                    ? 'Pause the campaign before changing it.'
                    : 'A finished campaign cannot be changed. Duplicate it to send a new version.'
            });
        }

        if (req.body.tenant_id !== row.tenant_id) {
            if (attempted(await statsOf(id)) > 0) {
                return res.status(409).json({
                    status: 'error',
                    message: 'The sending account cannot change once messages have gone out.'
                });
            }
            const tenant = await POSTGRESQLService.PostgresAny(`SELECT id FROM tenants WHERE id = $1`, [req.body.tenant_id]);
            if (!tenant.length) return res.status(400).json({ status: 'error', message: 'Customer not found.' });
        }

        const data = await POSTGRESQLService.PostgresUpdate(
            'campaigns', { ...campaignColumns(req.body), updated_at: new Date() }, id
        );
        res.json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'campaign.update');
    }
};

const remove = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        if (row.status === 'sending') {
            return res.status(409).json({ status: 'error', message: 'Pause or cancel the campaign before deleting it.' });
        }

        await POSTGRESQLService.PostgresDelete('campaigns', 'id', id);
        logger.warn('Campaign deleted', { id, by: req.email });
        res.json({ status: 'success', message: 'Campaign deleted.' });
    } catch (error) {
        handleServerError(res, error, 'campaign.remove');
    }
};

/**
 * Same message, settings and attachments as a new draft. The list is left
 * behind on purpose: a copy that could resend to everyone by accident is worse
 * than uploading the list again.
 */
const duplicate = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        const copy = await POSTGRESQLService.PostgresTransaction(async (client) => {
            const inserted = await client.query(
                `INSERT INTO campaigns (tenant_id, name, from_name, from_email, reply_to, subject, preheader,
                                        design, content, custom_html, track_opens, rate_per_minute, daily_limit)
                 SELECT tenant_id, left(name || ' (copy)', 150), from_name, from_email, reply_to, subject, preheader,
                        design, content, custom_html, track_opens, rate_per_minute, daily_limit
                   FROM campaigns WHERE id = $1
                 RETURNING *`,
                [id]
            );
            await client.query(
                `INSERT INTO campaign_attachments (campaign_id, filename, content_type, size_bytes, content)
                 SELECT $1::int, filename, content_type, size_bytes, content
                   FROM campaign_attachments WHERE campaign_id = $2 ORDER BY id`,
                [inserted.rows[0].id, id]
            );
            return inserted.rows[0];
        });

        logger.info('Campaign duplicated', { from: id, to: copy.id, by: req.email });
        res.status(201).json({
            status: 'success',
            message: 'Copied as a new draft. Upload a recipient list to send it.',
            data: copy
        });
    } catch (error) {
        handleServerError(res, error, 'campaign.duplicate');
    }
};

// ------------------------------------------------------------ recipients --

/**
 * Replaces the whole list with an uploaded CSV. Only while nothing has been
 * sent: after that, the report would no longer match what went out.
 */
const uploadRecipients = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        if (!EDITABLE.includes(row.status) || attempted(await statsOf(id)) > 0) {
            return res.status(409).json({ status: 'error', message: listLockedMessage() });
        }
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            return res.status(400).json({ status: 'error', message: 'Choose a CSV file to upload.' });
        }

        const parsed = parseRecipients(req.body);
        if (parsed.error) return res.status(400).json({ status: 'error', message: parsed.error });

        // Anyone who unsubscribed from this customer before is left out now —
        // and checked again by the sender right before each message.
        const emails = parsed.rows.map((r) => r.email);
        const blocked = emails.length
            ? await POSTGRESQLService.PostgresAny(
                `SELECT email FROM campaign_unsubscribes WHERE tenant_id = $1 AND email = ANY($2::text[])`,
                [row.tenant_id, emails]
            )
            : [];
        const suppressed = new Set(blocked.map((r) => r.email));
        const rows = parsed.rows.filter((r) => !suppressed.has(r.email));

        const summary = {
            filename: cleanFilename(req.query.filename) || null,
            total_rows: parsed.total_rows,
            imported: rows.length,
            invalid_count: parsed.invalid_count,
            invalid: parsed.invalid,
            duplicates: parsed.duplicates,
            suppressed: suppressed.size,
            columns: parsed.columns,
            uploaded_at: new Date().toISOString()
        };

        if (!rows.length) {
            return res.status(400).json({
                status: 'error',
                message: 'This file has no address that can be sent to, so the current list was kept.',
                data: summary
            });
        }

        await POSTGRESQLService.PostgresTransaction(async (client) => {
            await client.query(`DELETE FROM campaign_recipients WHERE campaign_id = $1`, [id]);
            for (let i = 0; i < rows.length; i += 2000) {
                const chunk = rows.slice(i, i + 2000);
                await client.query(
                    `INSERT INTO campaign_recipients (campaign_id, email, data, token)
                     SELECT $1::int, e, d::jsonb, t
                       FROM unnest($2::text[], $3::text[], $4::text[]) AS x(e, d, t)`,
                    [id, chunk.map((r) => r.email), chunk.map((r) => JSON.stringify(r.data)), chunk.map(() => newToken())]
                );
            }
            await client.query(
                `UPDATE campaigns SET columns = $2, import_summary = $3, updated_at = now() WHERE id = $1`,
                [id, summary.columns, JSON.stringify(summary)]
            );
        });

        logger.info('Campaign list uploaded', { id, imported: rows.length, invalid: parsed.invalid_count, by: req.email });
        res.json({ status: 'success', message: `${rows.length} recipient(s) ready.`, data: summary });
    } catch (error) {
        handleServerError(res, error, 'campaign.uploadRecipients');
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
            params.push(`%${req.query.search}%`);
            conditions.push(`(r.email ILIKE $${params.length} OR r.data::text ILIKE $${params.length})`);
        }
        const where = `WHERE ${conditions.join(' AND ')}`;

        const total = await POSTGRESQLService.PostgresAny(
            `SELECT count(*)::int AS total FROM campaign_recipients r ${where}`, params
        );

        params.push(limit, (page - 1) * limit);
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT r.id, r.email, r.data, r.status, r.error, r.attempted_at, r.sent_at,
                    r.opened_at, r.open_count, r.unsubscribed_at
               FROM campaign_recipients r
               ${where}
              ORDER BY r.id
              LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({
            status: 'success',
            data,
            pagination: { page, limit, total: total[0].total, pages: Math.ceil(total[0].total / limit) }
        });
    } catch (error) {
        handleServerError(res, error, 'campaign.listRecipients');
    }
};

/** Every row with its outcome, plus the original columns, for handing back to the customer. */
const exportRecipients = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT email, data, status, error, sent_at, opened_at, open_count, unsubscribed_at
               FROM campaign_recipients WHERE campaign_id = $1 ORDER BY id`,
            [id]
        );

        const dataKeys = [...new Set(rows.flatMap((r) => Object.keys(r.data || {})))].filter((k) => k !== 'email');
        const header = ['email', 'status', 'sent_at', 'opened_at', 'opens', 'unsubscribed_at', 'error', ...dataKeys];

        // A value starting with = + - @ is executed as a formula by Excel, so
        // prefix it with a quote before writing.
        const cell = (v) => {
            let s = v === null || v === undefined ? '' : (v instanceof Date ? v.toISOString() : String(v));
            if (/^[=+\-@]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
        };

        const lines = [header.map(cell).join(',')];
        for (const r of rows) {
            lines.push([
                r.email, r.status, r.sent_at, r.opened_at, r.open_count, r.unsubscribed_at, r.error,
                ...dataKeys.map((k) => (r.data || {})[k])
            ].map(cell).join(','));
        }

        const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'campaign';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${slug}-results.csv"`);
        res.send('\uFEFF' + lines.join('\n'));
    } catch (error) {
        handleServerError(res, error, 'campaign.exportRecipients');
    }
};

const clearRecipients = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        if (!EDITABLE.includes(row.status) || attempted(await statsOf(id)) > 0) {
            return res.status(409).json({ status: 'error', message: listLockedMessage() });
        }

        await POSTGRESQLService.PostgresTransaction(async (client) => {
            await client.query(`DELETE FROM campaign_recipients WHERE campaign_id = $1`, [id]);
            await client.query(
                `UPDATE campaigns SET columns = '{}', import_summary = NULL, updated_at = now() WHERE id = $1`, [id]
            );
        });
        res.json({ status: 'success', message: 'Recipient list cleared.' });
    } catch (error) {
        handleServerError(res, error, 'campaign.clearRecipients');
    }
};

// ----------------------------------------------------------- attachments --

/** One file per request, sent as the raw body with its name in ?filename=. */
const uploadAttachment = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        if (!EDITABLE.includes(row.status)) {
            return res.status(409).json({
                status: 'error',
                message: 'Attachments cannot change while the campaign is sending or after it has finished.'
            });
        }

        const filename = cleanFilename(req.query.filename);
        if (!filename) return res.status(400).json({ status: 'error', message: 'The file has no name.' });

        const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
        if (BLOCKED_EXTENSIONS.has(ext)) {
            return res.status(400).json({
                status: 'error',
                message: `Gmail and Outlook block .${ext} files, so every email would bounce. Share it as a download link instead.`
            });
        }
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            return res.status(400).json({ status: 'error', message: 'The file is empty.' });
        }

        const current = await POSTGRESQLService.PostgresAny(
            `SELECT count(*)::int AS files, COALESCE(sum(size_bytes), 0)::int AS bytes
               FROM campaign_attachments WHERE campaign_id = $1`,
            [id]
        );
        if (current[0].files >= MAX_ATTACHMENTS) {
            return res.status(400).json({ status: 'error', message: `A campaign can carry up to ${MAX_ATTACHMENTS} attachments.` });
        }
        if (current[0].bytes + req.body.length > MAX_ATTACHMENT_BYTES) {
            return res.status(400).json({
                status: 'error',
                message: `Attachments are limited to 15 MB per email in total — this file would make it `
                    + `${formatBytes(current[0].bytes + req.body.length)}. Compress it, or share it as a link.`
            });
        }

        const type = String(req.query.type || '');
        const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.slice(0, 100) : null;

        const inserted = await POSTGRESQLService.PostgresAny(
            `INSERT INTO campaign_attachments (campaign_id, filename, content_type, size_bytes, content)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, filename, content_type, size_bytes, created_at`,
            [id, filename, contentType, req.body.length, req.body]
        );
        await POSTGRESQLService.PostgresAny(`UPDATE campaigns SET updated_at = now() WHERE id = $1`, [id]);

        logger.info('Campaign attachment added', { id, filename, bytes: req.body.length, by: req.email });
        res.status(201).json({ status: 'success', data: inserted[0] });
    } catch (error) {
        handleServerError(res, error, 'campaign.uploadAttachment');
    }
};

const removeAttachment = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        if (!EDITABLE.includes(row.status)) {
            return res.status(409).json({
                status: 'error',
                message: 'Attachments cannot change while the campaign is sending or after it has finished.'
            });
        }

        const attachmentId = idParam(req.params.attachmentId);
        const deleted = attachmentId
            ? await POSTGRESQLService.PostgresAny(
                `DELETE FROM campaign_attachments WHERE id = $1 AND campaign_id = $2 RETURNING id`,
                [attachmentId, id]
            )
            : [];
        if (!deleted.length) return res.status(404).json({ status: 'error', message: 'Attachment not found' });

        res.json({ status: 'success', message: 'Attachment removed.' });
    } catch (error) {
        handleServerError(res, error, 'campaign.removeAttachment');
    }
};

// ------------------------------------------------------- preview and test --

/**
 * Renders the editor's current, unsaved state for one recipient. Nothing is
 * sent and nothing is stored.
 */
const preview = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        const draft = draftOf(row, req.body);
        const [recipient, attachments] = await Promise.all([
            pickRecipient(id, req.body.recipient_id),
            listAttachments(id)
        ]);

        const message = renderCampaign({
            campaign: draft,
            data: recipient.data,
            attachments,
            company: row.tenant_name,
            unsubscribeUrl: previewUnsubscribeUrl()
        });

        // Only the images the HTML actually shows are read, not every attachment.
        if (message.html.includes('cid:')) {
            const images = await POSTGRESQLService.PostgresAny(
                `SELECT filename, content_type, content FROM campaign_attachments
                  WHERE campaign_id = $1 AND position(('cid:' || filename) IN $2) > 0`,
                [id, message.html]
            );
            message.html = inlinePreviewImages(message.html, images);
        }

        res.json({
            status: 'success',
            data: {
                ...message,
                from_name: draft.from_name || row.smtp_from_name || row.tenant_name,
                from_email: draft.from_email || row.smtp_from_email || '',
                to: recipient.data.email,
                recipient_id: recipient.id,
                sample: recipient.sample
            }
        });
    } catch (error) {
        handleServerError(res, error, 'campaign.preview');
    }
};

/** Sends exactly what a recipient would get — attachments included — to one inbox. */
const sendTest = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        const to = cleanEmail(req.body.to);
        if (!isEmail(to)) {
            return res.status(400).json({ status: 'error', message: 'Enter a valid email address to send the test to.' });
        }

        const draft = draftOf(row, req.body);
        const recipient = await pickRecipient(id, req.body.recipient_id);
        const files = await POSTGRESQLService.PostgresAny(
            `SELECT filename, content_type, size_bytes, content
               FROM campaign_attachments WHERE campaign_id = $1 ORDER BY id`,
            [id]
        );
        const unsubscribeUrl = previewUnsubscribeUrl();
        const message = renderCampaign({
            campaign: draft,
            data: recipient.data,
            attachments: files,
            company: row.tenant_name,
            unsubscribeUrl
        });

        const sending = mailer.sendMail(row.tenant_id, {
            to: [to],
            bulk: true,
            fromName: draft.from_name || undefined,
            fromEmail: draft.from_email || undefined,
            replyTo: draft.reply_to || undefined,
            subject: `[TEST] ${message.subject}`,
            html: message.html,
            text: message.text,
            attachments: mailAttachments(files, message.html),
            headers: {
                'List-Unsubscribe': `<${unsubscribeUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
        });

        // A message with megabytes attached can take the server longer to accept
        // than nginx waits for this request (30 s). Past TEST_REPLY_WAIT_MS the
        // panel is told it is still on its way and the send finishes by itself —
        // instead of a 504 for an email that then arrives anyway.
        let timer;
        const stillSending = new Promise((resolve) => { timer = setTimeout(resolve, TEST_REPLY_WAIT_MS, 'still-sending'); });
        let outcome;
        try {
            outcome = await Promise.race([sending, stillSending]);
        } catch (error) {
            logger.warn('Campaign test send failed', { id, error: error.message });
            return res.status(400).json({ status: 'error', message: explainSmtpError(error, row.smtp_host || '') });
        } finally {
            clearTimeout(timer);
        }

        if (outcome === 'still-sending') {
            sending
                .then(() => logger.info('Campaign test sent after a slow reply', { id, to }))
                .catch((error) => logger.warn('Campaign test send failed after the panel was answered', { id, to, error: error.message }));
            const size = files.reduce((sum, f) => sum + Number(f.size_bytes || 0), 0);
            return res.status(202).json({
                status: 'success',
                message: `The mail server is still accepting this message${size ? ` (${formatBytes(size)} of attachments)` : ''}. `
                    + `The test to ${to} should arrive in a minute or two.`
            });
        }

        const as = recipient.sample ? '' : `, personalised as ${recipient.data.email}`;
        res.json({ status: 'success', message: `Test email sent to ${to}${as}.` });
    } catch (error) {
        handleServerError(res, error, 'campaign.sendTest');
    }
};

// --------------------------------------------------------------- actions --

/** Starts, resumes, or schedules. Everything that would make the send pointless is checked first. */
const start = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        if (!EDITABLE.includes(row.status)) {
            return res.status(409).json({
                status: 'error',
                message: row.status === 'sending'
                    ? 'This campaign is already sending.'
                    : 'A finished campaign cannot start again. Duplicate it, or retry its failed messages.'
            });
        }

        const stats = await statsOf(id);
        const content = row.content || {};
        const problems = [];
        if (!row.smtp_ready) {
            problems.push(`${row.tenant_name} has no active sending account. Set up SMTP on the customer first.`);
        }
        if (!String(row.subject || '').trim()) problems.push('Write a subject line.');
        const hasMessage = row.design === 'custom'
            ? String(row.custom_html || '').trim()
            : String(content.body || '').trim() || String(content.headline || '').trim();
        if (!hasMessage) problems.push('Write the message.');
        if (row.design === 'custom') {
            // An image the HTML shows but nobody uploaded would arrive broken in every inbox.
            const uploaded = (await listAttachments(id)).map((a) => a.filename);
            const missing = missingInlineImages(row.custom_html, uploaded);
            if (missing.length) {
                problems.push(`The HTML shows ${missing.map((m) => `cid:${m}`).join(', ')}, but no attachment has `
                    + 'that name. Upload the image in step 3, named exactly the same.');
            }
        }
        if (!stats.pending) {
            problems.push(stats.failed
                ? 'Nothing is waiting to be sent. Use "Retry failed" to try the failed messages again.'
                : 'Upload the recipient list.');
        }
        if (problems.length) return res.status(400).json({ status: 'error', message: problems.join('\n') });

        let scheduledAt = null;
        if (req.body && req.body.scheduled_at) {
            const when = new Date(req.body.scheduled_at);
            if (Number.isNaN(when.getTime())) {
                return res.status(400).json({ status: 'error', message: 'Choose a valid date and time.' });
            }
            if (when.getTime() < Date.now() - 60 * 1000) {
                return res.status(400).json({ status: 'error', message: 'That time has already passed.' });
            }
            if (when.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) {
                return res.status(400).json({ status: 'error', message: 'Schedule it within the next year.' });
            }
            // A time a few seconds away is "now".
            if (when.getTime() > Date.now() + 30 * 1000) scheduledAt = when;
        }

        if (scheduledAt) {
            await POSTGRESQLService.PostgresAny(
                `UPDATE campaigns
                    SET status = 'scheduled', scheduled_at = $2, next_send_at = NULL, status_reason = NULL,
                        retry_count = 0, completed_at = NULL, updated_at = now()
                  WHERE id = $1`,
                [id, scheduledAt]
            );
        } else {
            await POSTGRESQLService.PostgresAny(
                `UPDATE campaigns
                    SET status = 'sending', scheduled_at = NULL, started_at = COALESCE(started_at, now()),
                        next_send_at = now(), status_reason = NULL, retry_count = 0, completed_at = NULL, updated_at = now()
                  WHERE id = $1`,
                [id]
            );
        }

        logger.info(scheduledAt ? 'Campaign scheduled' : 'Campaign started', {
            id, recipients: stats.pending, scheduledAt, by: req.email
        });
        res.json({
            status: 'success',
            message: scheduledAt ? 'Campaign scheduled.' : `Sending to ${stats.pending} recipient(s) has started.`
        });
    } catch (error) {
        handleServerError(res, error, 'campaign.start');
    }
};

const pause = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        if (row.status === 'sending') {
            await POSTGRESQLService.PostgresAny(
                `UPDATE campaigns SET status = 'paused', next_send_at = NULL, status_reason = NULL, updated_at = now()
                  WHERE id = $1 AND status = 'sending'`,
                [id]
            );
            logger.info('Campaign paused', { id, by: req.email });
            return res.json({ status: 'success', message: 'Paused. Resume whenever you are ready.' });
        }

        if (row.status === 'scheduled') {
            // Back to where it was before scheduling: a draft if nothing has
            // gone out yet, otherwise paused.
            const next = attempted(await statsOf(id)) > 0 ? 'paused' : 'draft';
            await POSTGRESQLService.PostgresAny(
                `UPDATE campaigns SET status = $2, scheduled_at = NULL, updated_at = now()
                  WHERE id = $1 AND status = 'scheduled'`,
                [id, next]
            );
            return res.json({ status: 'success', message: 'Unscheduled. Nothing is sent until you start it again.' });
        }

        res.status(409).json({ status: 'error', message: 'Only a sending or scheduled campaign can be paused.' });
    } catch (error) {
        handleServerError(res, error, 'campaign.pause');
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
            `UPDATE campaigns
                SET status = 'cancelled', next_send_at = NULL, scheduled_at = NULL, status_reason = NULL,
                    completed_at = now(), updated_at = now()
              WHERE id = $1`,
            [id]
        );
        logger.warn('Campaign cancelled', { id, by: req.email });
        res.json({ status: 'success', message: 'Cancelled. Nothing more will be sent.' });
    } catch (error) {
        handleServerError(res, error, 'campaign.cancel');
    }
};

const retryFailed = async (req, res) => {
    try {
        const id = idParam(req.params.id);
        const row = id && await loadCampaign(id);
        if (!row) return notFound(res);

        if (!['completed', 'paused'].includes(row.status)) {
            return res.status(409).json({
                status: 'error',
                message: 'Failed messages can be retried once the campaign has finished, or while it is paused.'
            });
        }

        const reset = await POSTGRESQLService.PostgresAny(
            `UPDATE campaign_recipients SET status = 'pending', error = NULL, attempted_at = NULL
              WHERE campaign_id = $1 AND status = 'failed'
            RETURNING id`,
            [id]
        );
        if (!reset.length) return res.status(400).json({ status: 'error', message: 'There are no failed messages to retry.' });

        if (row.status === 'completed') {
            await POSTGRESQLService.PostgresAny(
                `UPDATE campaigns
                    SET status = 'sending', completed_at = NULL, next_send_at = now(), retry_count = 0,
                        status_reason = NULL, updated_at = now()
                  WHERE id = $1`,
                [id]
            );
        }

        logger.info('Campaign failed messages requeued', { id, count: reset.length, by: req.email });
        res.json({
            status: 'success',
            message: `${reset.length} message(s) queued again.${row.status === 'paused' ? ' Resume the campaign to send them.' : ''}`
        });
    } catch (error) {
        handleServerError(res, error, 'campaign.retryFailed');
    }
};

// ------------------------------------------------------ do-not-email list --

const listUnsubscribes = async (req, res) => {
    try {
        const tenantId = idParam(req.query.tenant_id);
        if (!tenantId) return res.status(400).json({ status: 'error', message: 'Choose a customer.' });

        const data = await POSTGRESQLService.PostgresAny(
            `SELECT u.id, u.email, u.source, u.created_at, c.name AS campaign_name
               FROM campaign_unsubscribes u
               LEFT JOIN campaigns c ON c.id = u.campaign_id
              WHERE u.tenant_id = $1
              ORDER BY u.created_at DESC
              LIMIT 5000`,
            [tenantId]
        );
        res.json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'campaign.listUnsubscribes');
    }
};

/** For the "please take me off your list" reply that never went near a link. */
const addUnsubscribes = async (req, res) => {
    try {
        const tenant = await POSTGRESQLService.PostgresAny(`SELECT id FROM tenants WHERE id = $1`, [req.body.tenant_id]);
        if (!tenant.length) return res.status(400).json({ status: 'error', message: 'Customer not found.' });

        const candidates = [...new Set(String(req.body.emails).split(/[\s,;]+/).map(cleanEmail).filter(Boolean))];
        const valid = candidates.filter(isEmail);
        const invalid = candidates.filter((e) => !isEmail(e));
        if (!valid.length) return res.status(400).json({ status: 'error', message: 'No valid email address found.' });

        const added = await POSTGRESQLService.PostgresAny(
            `INSERT INTO campaign_unsubscribes (tenant_id, email, source)
             SELECT $1::int, e, 'manual' FROM unnest($2::text[]) AS e
             ON CONFLICT (tenant_id, email) DO NOTHING
             RETURNING id`,
            [req.body.tenant_id, valid]
        );

        const skipped = invalid.length
            ? ` Skipped ${invalid.length} invalid: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}.`
            : '';
        logger.info('Do-not-email list updated', { tenantId: req.body.tenant_id, added: added.length, by: req.email });
        res.json({ status: 'success', message: `${added.length} address(es) added to the do-not-email list.${skipped}` });
    } catch (error) {
        handleServerError(res, error, 'campaign.addUnsubscribes');
    }
};

const removeUnsubscribe = async (req, res) => {
    try {
        const id = idParam(req.params.unsubscribeId);
        const deleted = id
            ? await POSTGRESQLService.PostgresAny(
                `DELETE FROM campaign_unsubscribes WHERE id = $1 RETURNING email, tenant_id`, [id]
            )
            : [];
        if (!deleted.length) return res.status(404).json({ status: 'error', message: 'Address not found on the list.' });

        logger.warn('Removed from do-not-email list', { email: deleted[0].email, tenantId: deleted[0].tenant_id, by: req.email });
        res.json({ status: 'success', message: `${deleted[0].email} can be emailed again.` });
    } catch (error) {
        handleServerError(res, error, 'campaign.removeUnsubscribe');
    }
};

module.exports = {
    getAll, getOne, create, update, remove, duplicate,
    uploadRecipients, listRecipients, exportRecipients, clearRecipients,
    uploadAttachment, removeAttachment,
    preview, sendTest,
    start, pause, cancel, retryFailed,
    listUnsubscribes, addUnsubscribes, removeUnsubscribe
};
