const POSTGRESQLService = require('../helpers/POSTGRES');
const templateHelper = require('../helpers/template');
const mailer = require('../helpers/mailer');
const logger = require('../helpers/logger');

const handleServerError = (res, error, where) => {
    logger.error(`${where} failed`, { error: error.message, stack: error.stack });
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};

const getByForm = async (req, res) => {
    try {
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM email_templates WHERE form_id = $1 ORDER BY template_type`,
            [req.params.formId]
        );
        res.json({ status: 'success', data, defaults: templateHelper.DEFAULTS });
    } catch (error) {
        handleServerError(res, error, 'template.getByForm');
    }
};

/** One row per (form, type), so save is an upsert rather than create-or-edit. */
const save = async (req, res) => {
    try {
        const formId = Number(req.params.formId);
        const form = await POSTGRESQLService.PostgresAny(`SELECT id FROM forms WHERE id = $1`, [formId]);
        if (!form.length) return res.status(404).json({ status: 'error', message: 'Form not found' });

        const values = {
            form_id: formId,
            template_type: req.body.template_type,
            subject: req.body.subject,
            html_body: req.body.html_body,
            text_body: req.body.text_body || null,
            is_active: req.body.is_active,
            updated_at: new Date()
        };

        const existing = await POSTGRESQLService.PostgresAny(
            `SELECT id FROM email_templates WHERE form_id = $1 AND template_type = $2`,
            [formId, req.body.template_type]
        );

        const data = existing.length
            ? await POSTGRESQLService.PostgresUpdate('email_templates', values, existing[0].id)
            : await POSTGRESQLService.PostgresInsert('email_templates', values);

        logger.info('Template saved', { formId, type: req.body.template_type, by: req.email });
        res.json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'template.save');
    }
};

/**
 * Renders the template with fake values so you can see the result before a real
 * visitor does. Nothing is sent and nothing is stored.
 */
const preview = async (req, res) => {
    try {
        const formId = Number(req.params.formId);
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT f.*, t.name AS tenant_name FROM forms f JOIN tenants t ON t.id = f.tenant_id WHERE f.id = $1`,
            [formId]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'Form not found' });
        const form = rows[0];

        const fields = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM form_fields WHERE form_id = $1 AND is_active = true ORDER BY sort_order`,
            [formId]
        );

        const sample = {};
        for (const f of fields) {
            switch (f.field_type) {
                case 'email': sample[f.field_key] = 'visitor@example.com'; break;
                case 'tel': sample[f.field_key] = '+91 98765 43210'; break;
                case 'number': sample[f.field_key] = 42; break;
                case 'date': sample[f.field_key] = '2026-08-06'; break;
                case 'url': sample[f.field_key] = 'https://example.com'; break;
                case 'checkbox': sample[f.field_key] = true; break;
                case 'checkbox_group': sample[f.field_key] = (f.options || []).slice(0, 2).map((o) => o.value); break;
                case 'select':
                case 'radio': sample[f.field_key] = (f.options || [])[0]?.value || 'Option 1'; break;
                case 'textarea': sample[f.field_key] = 'This is a sample message from the preview.'; break;
                default: sample[f.field_key] = `Sample ${f.label}`;
            }
        }

        const meta = {
            date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            ip: '203.0.113.10',
            form_name: form.name,
            tenant_name: form.tenant_name
        };

        const { subject, html_body, text_body } = req.body || {};
        res.json({
            status: 'success',
            data: {
                subject: templateHelper.sanitizeHeader(
                    templateHelper.render(subject || '', sample, fields, meta, { escape: false })
                ),
                html: templateHelper.wrapHtml(
                    templateHelper.render(html_body || '', sample, fields, meta),
                    form.name
                ),
                text: templateHelper.render(text_body || '', sample, fields, meta, { escape: false })
            }
        });
    } catch (error) {
        handleServerError(res, error, 'template.preview');
    }
};

/** Sends the previewed template to a real inbox over the customer's SMTP. */
const sendTest = async (req, res) => {
    try {
        const formId = Number(req.params.formId);
        const to = req.body && req.body.to;
        if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) {
            return res.status(400).json({ status: 'error', message: 'A valid recipient email is required.' });
        }

        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT f.*, t.name AS tenant_name FROM forms f JOIN tenants t ON t.id = f.tenant_id WHERE f.id = $1`,
            [formId]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'Form not found' });
        const form = rows[0];

        const type = req.body.template_type === 'autoreply' ? 'autoreply' : 'admin';
        const tplRows = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM email_templates WHERE form_id = $1 AND template_type = $2`, [formId, type]
        );
        const tpl = tplRows[0] || templateHelper.DEFAULTS[type];

        const fields = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM form_fields WHERE form_id = $1 AND is_active = true ORDER BY sort_order`, [formId]
        );

        const sample = {};
        for (const f of fields) sample[f.field_key] = `Sample ${f.label}`;
        const meta = {
            date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            ip: '203.0.113.10',
            form_name: form.name,
            tenant_name: form.tenant_name
        };

        await mailer.sendMail(form.tenant_id, {
            to: [String(to)],
            subject: `[TEST] ${templateHelper.sanitizeHeader(templateHelper.render(tpl.subject, sample, fields, meta, { escape: false }))}`,
            html: templateHelper.wrapHtml(templateHelper.render(tpl.html_body, sample, fields, meta), form.name),
            text: templateHelper.render(tpl.text_body, sample, fields, meta, { escape: false })
        });

        res.json({ status: 'success', message: `Test email sent to ${to}.` });
    } catch (error) {
        logger.warn('Template test send failed', { formId: req.params.formId, error: error.message });
        res.status(400).json({ status: 'error', message: `Could not send: ${error.message}` });
    }
};

module.exports = { getByForm, save, preview, sendTest };
