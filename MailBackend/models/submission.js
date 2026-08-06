const POSTGRESQLService = require('../helpers/POSTGRES');
const templateHelper = require('../helpers/template');
const mailer = require('../helpers/mailer');
const logger = require('../helpers/logger');

const handleServerError = (res, error, where) => {
    logger.error(`${where} failed`, { error: error.message, stack: error.stack });
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};

/** Paged, filterable log. Every filter is a bound parameter, never interpolated. */
const getAll = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
        const offset = (page - 1) * limit;

        const conditions = [];
        const params = [];

        if (req.query.form_id) { params.push(req.query.form_id); conditions.push(`s.form_id = $${params.length}`); }
        if (req.query.tenant_id) { params.push(req.query.tenant_id); conditions.push(`s.tenant_id = $${params.length}`); }
        if (req.query.status) { params.push(req.query.status); conditions.push(`s.mail_status = $${params.length}`); }
        if (req.query.from_date) { params.push(req.query.from_date); conditions.push(`s.created_at >= $${params.length}`); }
        if (req.query.to_date) { params.push(req.query.to_date); conditions.push(`s.created_at < ($${params.length}::date + 1)`); }
        if (req.query.search) {
            params.push(`%${req.query.search}%`);
            conditions.push(`s.data::text ILIKE $${params.length}`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const totalRows = await POSTGRESQLService.PostgresAny(
            `SELECT count(*)::int AS total FROM submissions s ${where}`, params
        );

        params.push(limit, offset);
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT s.*, f.name AS form_name, f.form_key, t.name AS tenant_name
               FROM submissions s
               JOIN forms f ON f.id = s.form_id
               JOIN tenants t ON t.id = s.tenant_id
               ${where}
              ORDER BY s.created_at DESC
              LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({
            status: 'success',
            data,
            pagination: { page, limit, total: totalRows[0].total, pages: Math.ceil(totalRows[0].total / limit) }
        });
    } catch (error) {
        handleServerError(res, error, 'submission.getAll');
    }
};

const getOne = async (req, res) => {
    try {
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT s.*, f.name AS form_name, t.name AS tenant_name
               FROM submissions s
               JOIN forms f ON f.id = s.form_id
               JOIN tenants t ON t.id = s.tenant_id
              WHERE s.id = $1`,
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'Submission not found' });

        const fields = await POSTGRESQLService.PostgresAny(
            `SELECT field_key, label, field_type, sort_order FROM form_fields
              WHERE form_id = $1 ORDER BY sort_order`,
            [rows[0].form_id]
        );

        res.json({ status: 'success', data: { ...rows[0], fields } });
    } catch (error) {
        handleServerError(res, error, 'submission.getOne');
    }
};

/**
 * Re-sends a notification that failed.
 *
 * Because the submission was stored before the send was attempted, a mail
 * outage is fully recoverable from the panel — nothing has to be re-typed by
 * the visitor.
 */
const resend = async (req, res) => {
    try {
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT s.*, f.name AS form_name, f.recipients, f.cc, f.bcc, f.autoreply_to_field,
                    t.name AS tenant_name
               FROM submissions s
               JOIN forms f ON f.id = s.form_id
               JOIN tenants t ON t.id = s.tenant_id
              WHERE s.id = $1`,
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'Submission not found' });

        const sub = rows[0];
        if (!sub.recipients || !sub.recipients.length) {
            return res.status(400).json({ status: 'error', message: 'This form has no recipients configured.' });
        }

        const fields = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM form_fields WHERE form_id = $1 ORDER BY sort_order`, [sub.form_id]
        );
        const tplRows = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM email_templates WHERE form_id = $1 AND template_type = 'admin'`, [sub.form_id]
        );
        const tpl = tplRows[0] || templateHelper.DEFAULTS.admin;

        const data = sub.data || {};
        const meta = {
            date: new Date(sub.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            ip: sub.ip,
            form_name: sub.form_name,
            tenant_name: sub.tenant_name
        };

        const visitorEmail = sub.autoreply_to_field ? data[sub.autoreply_to_field] : null;
        const replyTo = visitorEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(visitorEmail))
            ? String(visitorEmail) : null;

        const info = await mailer.sendMail(sub.tenant_id, {
            to: sub.recipients,
            cc: sub.cc,
            bcc: sub.bcc,
            replyTo,
            subject: templateHelper.sanitizeHeader(
                templateHelper.render(tpl.subject, data, fields, meta, { escape: false })
            ),
            html: templateHelper.wrapHtml(templateHelper.render(tpl.html_body, data, fields, meta), sub.form_name),
            text: templateHelper.render(tpl.text_body, data, fields, meta, { escape: false })
        });

        await POSTGRESQLService.PostgresAny(
            `UPDATE submissions SET mail_status = 'sent', message_id = $1, mail_error = NULL WHERE id = $2`,
            [info.messageId, sub.id]
        );

        logger.info('Submission resent', { id: sub.id, by: req.email });
        res.json({ status: 'success', message: 'Notification resent.' });
    } catch (error) {
        logger.warn('Resend failed', { id: req.params.id, error: error.message });
        res.status(400).json({ status: 'error', message: `Could not resend: ${error.message}` });
    }
};

const remove = async (req, res) => {
    try {
        await POSTGRESQLService.PostgresDelete('submissions', 'id', req.params.id);
        res.json({ status: 'success', message: 'Submission deleted.' });
    } catch (error) {
        handleServerError(res, error, 'submission.remove');
    }
};

/** Counters for the dashboard landing page. */
const stats = async (req, res) => {
    try {
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT
                (SELECT count(*)::int FROM tenants WHERE is_active) AS active_tenants,
                (SELECT count(*)::int FROM forms WHERE is_active) AS active_forms,
                (SELECT count(*)::int FROM submissions
                  WHERE mail_status <> 'spam' AND created_at > now() - interval '30 days') AS submissions_30d,
                (SELECT count(*)::int FROM submissions
                  WHERE mail_status = 'failed' AND created_at > now() - interval '30 days') AS failed_30d,
                (SELECT count(*)::int FROM submissions
                  WHERE mail_status = 'spam' AND created_at > now() - interval '30 days') AS spam_30d`,
            []
        );

        const recent = await POSTGRESQLService.PostgresAny(
            `SELECT s.id, s.created_at, s.mail_status, f.name AS form_name, t.name AS tenant_name
               FROM submissions s
               JOIN forms f ON f.id = s.form_id
               JOIN tenants t ON t.id = s.tenant_id
              WHERE s.mail_status <> 'spam'
              ORDER BY s.created_at DESC LIMIT 10`,
            []
        );

        const daily = await POSTGRESQLService.PostgresAny(
            `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS total
               FROM submissions
              WHERE mail_status <> 'spam' AND created_at > now() - interval '14 days'
              GROUP BY 1 ORDER BY 1`,
            []
        );

        res.json({ status: 'success', data: { ...rows[0], recent, daily } });
    } catch (error) {
        handleServerError(res, error, 'submission.stats');
    }
};

/** CSV export of the current filter, for handing data to the customer. */
const exportCsv = async (req, res) => {
    try {
        const conditions = [];
        const params = [];
        if (req.query.form_id) { params.push(req.query.form_id); conditions.push(`s.form_id = $${params.length}`); }
        if (req.query.tenant_id) { params.push(req.query.tenant_id); conditions.push(`s.tenant_id = $${params.length}`); }
        conditions.push(`s.mail_status <> 'spam'`);
        const where = `WHERE ${conditions.join(' AND ')}`;

        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT s.id, s.created_at, s.mail_status, s.ip, s.data, f.name AS form_name, t.name AS tenant_name
               FROM submissions s
               JOIN forms f ON f.id = s.form_id
               JOIN tenants t ON t.id = s.tenant_id
               ${where}
              ORDER BY s.created_at DESC LIMIT 5000`,
            params
        );

        const dataKeys = [...new Set(rows.flatMap((r) => Object.keys(r.data || {})))];
        const header = ['id', 'created_at', 'customer', 'form', 'status', 'ip', ...dataKeys];

        // A value starting with = + - @ is executed as a formula by Excel, so
        // prefix it with a quote before writing.
        const cell = (v) => {
            let s = Array.isArray(v) ? v.join('; ') : (v === null || v === undefined ? '' : String(v));
            if (/^[=+\-@]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
        };

        const lines = [header.map(cell).join(',')];
        for (const r of rows) {
            lines.push([
                r.id,
                new Date(r.created_at).toISOString(),
                r.tenant_name, r.form_name, r.mail_status, r.ip,
                ...dataKeys.map((k) => (r.data || {})[k])
            ].map(cell).join(','));
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="submissions-${Date.now()}.csv"`);
        res.send('﻿' + lines.join('\n'));
    } catch (error) {
        handleServerError(res, error, 'submission.exportCsv');
    }
};

module.exports = { getAll, getOne, resend, remove, stats, exportCsv };
