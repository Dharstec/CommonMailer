const POSTGRESQLService = require('../helpers/POSTGRES');
const { encrypt } = require('../helpers/crypto');
const { safePattern } = require('../helpers/dynamicValidator');
const templateHelper = require('../helpers/template');
const { buildLinks } = require('../helpers/links');
const logger = require('../helpers/logger');
require('dotenv').config();

const handleServerError = (res, error, where) => {
    logger.error(`${where} failed`, { error: error.message, stack: error.stack });
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};

/** The one field every form must have, on every customer. */
const EMAIL_FIELD_KEY = 'email';

/** Columns of `forms` that a write actually owns, in DB order. */
function formColumns(body, recaptchaSecretEnc) {
    return {
        tenant_id: body.tenant_id,
        form_key: body.form_key,
        name: body.name,
        description: body.description || null,
        recipients: body.recipients,
        cc: body.cc || [],
        bcc: body.bcc || [],
        allowed_origins: body.allowed_origins || [],
        title: body.title || null,
        intro_text: body.intro_text || null,
        submit_button_text: body.submit_button_text,
        success_message: body.success_message,
        layout_columns: body.layout_columns,
        honeypot_field: body.honeypot_field,
        min_submit_seconds: body.min_submit_seconds,
        max_per_hour_per_ip: body.max_per_hour_per_ip,
        require_origin: body.require_origin,
        duplicate_window_minutes: body.duplicate_window_minutes,
        content_filter_enabled: body.content_filter_enabled,
        recaptcha_enabled: body.recaptcha_enabled,
        recaptcha_site_key: body.recaptcha_site_key || null,
        recaptcha_secret_enc: recaptchaSecretEnc,
        recaptcha_min_score: body.recaptcha_min_score,
        autoreply_enabled: body.autoreply_enabled,
        autoreply_to_field: body.autoreply_to_field || null,
        store_submissions: body.store_submissions,
        is_active: body.is_active
    };
}

/**
 * Cross-field checks that Joi cannot express on its own, because they depend on
 * the field list the same request is submitting.
 */
function validateFieldSet(body) {
    const fields = body.fields || [];
    const keys = fields.map((f) => f.field_key);

    const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
    if (duplicate) return `Duplicate field key "${duplicate}". Each field key must be unique within a form.`;

    // Every form carries an email address, whatever else the customer needs.
    // Enforced here rather than only in the panel, so a form created straight
    // through the API cannot end up with no way to reply to the sender.
    const email = fields.find((f) => f.field_key === EMAIL_FIELD_KEY);
    if (!email) {
        return `Every form must include an "${EMAIL_FIELD_KEY}" field. Add it back before saving.`;
    }
    if (email.field_type !== 'email') {
        return `The "${EMAIL_FIELD_KEY}" field must be of type "email".`;
    }
    if (!email.is_required) {
        return `The "${EMAIL_FIELD_KEY}" field must stay required.`;
    }
    if (email.is_active === false) {
        return `The "${EMAIL_FIELD_KEY}" field cannot be switched off.`;
    }

    if (keys.includes(body.honeypot_field)) {
        return `The honeypot name "${body.honeypot_field}" clashes with a real field. Choose a different honeypot name.`;
    }
    if (keys.includes('_ts') || keys.includes('_captcha')) {
        return 'Field keys "_ts" and "_captcha" are reserved.';
    }

    // An auto-reply with no address to reply to would silently never send.
    if (body.autoreply_enabled) {
        if (!body.autoreply_to_field) {
            return 'Auto-reply is enabled but no email field is selected to reply to.';
        }
        const target = fields.find((f) => f.field_key === body.autoreply_to_field);
        if (!target) return `Auto-reply field "${body.autoreply_to_field}" is not one of this form's fields.`;
        if (target.field_type !== 'email') return 'The auto-reply field must be of type "email".';
    }

    for (const f of fields) {
        if (['select', 'radio', 'checkbox_group'].includes(f.field_type) && (!f.options || !f.options.length)) {
            return `Field "${f.label}" is a ${f.field_type} and needs at least one option.`;
        }
        if (f.min_length && f.max_length && f.min_length > f.max_length) {
            return `Field "${f.label}" has a minimum length greater than its maximum length.`;
        }
        // Reject regexes we would refuse to run at submit time, so the admin
        // finds out here rather than wondering why the rule never fires.
        if (f.pattern && !safePattern(f.pattern)) {
            return `Field "${f.label}" has an invalid or unsafe pattern. Avoid nested quantifiers like (a+)+.`;
        }
    }

    return null;
}

/** Replaces a form's field rows wholesale, inside the caller's transaction. */
async function writeFields(client, formId, fields) {
    await client.query(`DELETE FROM form_fields WHERE form_id = $1`, [formId]);

    for (const [index, f] of fields.entries()) {
        await client.query(
            `INSERT INTO form_fields
               (form_id, field_key, label, field_type, placeholder, help_text, default_value,
                is_required, min_length, max_length, min_value, max_value, pattern, pattern_message,
                options, textarea_rows, col_span, sort_order, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [
                formId, f.field_key, f.label, f.field_type, f.placeholder || null, f.help_text || null,
                f.default_value || null, f.is_required, f.min_length ?? null, f.max_length ?? null,
                f.min_value ?? null, f.max_value ?? null, f.pattern || null, f.pattern_message || null,
                JSON.stringify(f.options || []), f.textarea_rows, f.col_span,
                f.sort_order !== undefined ? f.sort_order : index, f.is_active
            ]
        );
    }
}

const getAll = async (req, res) => {
    try {
        const params = [];
        let where = '';
        if (req.query.tenant_id) {
            params.push(req.query.tenant_id);
            where = `WHERE f.tenant_id = $1`;
        }

        const data = await POSTGRESQLService.PostgresAny(
            `SELECT f.id, f.tenant_id, f.form_key, f.name, f.description, f.is_active,
                    f.recipients, f.created_at, t.name AS tenant_name, t.slug AS tenant_slug,
                    (SELECT count(*)::int FROM form_fields ff WHERE ff.form_id = f.id) AS field_count,
                    (SELECT count(*)::int FROM submissions s
                      WHERE s.form_id = f.id AND s.mail_status <> 'spam') AS submission_count
               FROM forms f
               JOIN tenants t ON t.id = f.tenant_id
               ${where}
              ORDER BY f.created_at DESC`,
            params
        );
        // The list page shows a copyable share link per card, so the links ride
        // along rather than needing a request per form.
        res.json({
            status: 'success',
            data: data.map((f) => ({ ...f, links: buildLinks(f.form_key) }))
        });
    } catch (error) {
        handleServerError(res, error, 'form.getAll');
    }
};

const getOne = async (req, res) => {
    try {
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT f.*, t.name AS tenant_name FROM forms f
               JOIN tenants t ON t.id = f.tenant_id
              WHERE f.id = $1`,
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'Form not found' });

        const form = rows[0];
        const secretConfigured = Boolean(form.recaptcha_secret_enc);
        delete form.recaptcha_secret_enc;

        const fields = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM form_fields WHERE form_id = $1 ORDER BY sort_order ASC, id ASC`,
            [form.id]
        );
        const templates = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM email_templates WHERE form_id = $1`, [form.id]
        );

        res.json({
            status: 'success',
            data: {
                ...form,
                recaptcha_secret_configured: secretConfigured,
                fields,
                templates,
                links: buildLinks(form.form_key)
            }
        });
    } catch (error) {
        handleServerError(res, error, 'form.getOne');
    }
};

// Link set (share URL, iframe, script tag) now lives in helpers/links.js so the
// same shapes are returned everywhere and shown in the panel.

const create = async (req, res) => {
    try {
        const fieldError = validateFieldSet(req.body);
        if (fieldError) return res.status(400).json({ status: 'error', message: fieldError });

        const clash = await POSTGRESQLService.PostgresAny(`SELECT id FROM forms WHERE form_key = $1`, [req.body.form_key]);
        if (clash.length) {
            return res.status(409).json({ status: 'error', message: 'That form key is already in use. Pick another.' });
        }

        const tenant = await POSTGRESQLService.PostgresAny(`SELECT id FROM tenants WHERE id = $1`, [req.body.tenant_id]);
        if (!tenant.length) return res.status(400).json({ status: 'error', message: 'Customer not found.' });

        const secretEnc = req.body.recaptcha_secret ? encrypt(req.body.recaptcha_secret) : null;

        const form = await POSTGRESQLService.PostgresTransaction(async (client) => {
            const cols = formColumns(req.body, secretEnc);
            const names = Object.keys(cols);
            const placeholders = names.map((_, i) => `$${i + 1}`).join(', ');
            const inserted = await client.query(
                `INSERT INTO forms (${names.join(', ')}) VALUES (${placeholders}) RETURNING *`,
                Object.values(cols)
            );
            const row = inserted.rows[0];

            await writeFields(client, row.id, req.body.fields);

            // Seed both templates so a new form can send immediately; you can
            // rewrite them afterwards in the template editor.
            for (const type of ['admin', 'autoreply']) {
                const d = templateHelper.DEFAULTS[type];
                await client.query(
                    `INSERT INTO email_templates (form_id, template_type, subject, html_body, text_body)
                     VALUES ($1,$2,$3,$4,$5)`,
                    [row.id, type, d.subject, d.html_body, d.text_body]
                );
            }

            return row;
        });

        logger.info('Form created', { id: form.id, form_key: form.form_key, by: req.email });
        res.status(201).json({
            status: 'success',
            data: { ...form, links: buildLinks(form.form_key) }
        });
    } catch (error) {
        handleServerError(res, error, 'form.create');
    }
};

const update = async (req, res) => {
    try {
        const fieldError = validateFieldSet(req.body);
        if (fieldError) return res.status(400).json({ status: 'error', message: fieldError });

        const id = Number(req.params.id);
        const current = await POSTGRESQLService.PostgresAny(`SELECT * FROM forms WHERE id = $1`, [id]);
        if (!current.length) return res.status(404).json({ status: 'error', message: 'Form not found' });

        const clash = await POSTGRESQLService.PostgresAny(
            `SELECT id FROM forms WHERE form_key = $1 AND id <> $2`, [req.body.form_key, id]
        );
        if (clash.length) {
            return res.status(409).json({ status: 'error', message: 'That form key is already in use. Pick another.' });
        }

        // Blank secret on an update keeps the stored one, same rule as SMTP.
        const secretEnc = req.body.recaptcha_secret
            ? encrypt(req.body.recaptcha_secret)
            : current[0].recaptcha_secret_enc;

        const form = await POSTGRESQLService.PostgresTransaction(async (client) => {
            const cols = { ...formColumns(req.body, secretEnc), updated_at: new Date() };
            const setClause = Object.keys(cols).map((k, i) => `${k} = $${i + 1}`).join(', ');
            const updated = await client.query(
                `UPDATE forms SET ${setClause} WHERE id = $${Object.keys(cols).length + 1} RETURNING *`,
                [...Object.values(cols), id]
            );

            await writeFields(client, id, req.body.fields);
            return updated.rows[0];
        });

        logger.info('Form updated', { id, form_key: form.form_key, by: req.email });
        res.json({ status: 'success', data: { ...form, links: buildLinks(form.form_key) } });
    } catch (error) {
        handleServerError(res, error, 'form.update');
    }
};

const remove = async (req, res) => {
    try {
        await POSTGRESQLService.PostgresDelete('forms', 'id', req.params.id);
        logger.warn('Form deleted', { id: req.params.id, by: req.email });
        res.json({ status: 'success', message: 'Form deleted.' });
    } catch (error) {
        handleServerError(res, error, 'form.remove');
    }
};

/**
 * Clones an existing form onto another customer.
 *
 * This is the fast path you asked for: the second customer who wants "the same
 * contact form" is a duplicate + rename, not a rebuild.
 */
const duplicate = async (req, res) => {
    try {
        const sourceId = Number(req.params.id);
        const { tenant_id, form_key, name } = req.body || {};
        if (!tenant_id || !form_key || !name) {
            return res.status(400).json({ status: 'error', message: 'tenant_id, form_key and name are required.' });
        }
        if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(String(form_key))) {
            return res.status(400).json({ status: 'error', message: 'form_key may contain only lowercase letters, numbers and hyphens.' });
        }

        const clash = await POSTGRESQLService.PostgresAny(`SELECT id FROM forms WHERE form_key = $1`, [form_key]);
        if (clash.length) return res.status(409).json({ status: 'error', message: 'That form key is already in use.' });

        const newForm = await POSTGRESQLService.PostgresTransaction(async (client) => {
            const src = (await client.query(`SELECT * FROM forms WHERE id = $1`, [sourceId])).rows[0];
            if (!src) throw new Error('Source form not found');

            const inserted = await client.query(
                `INSERT INTO forms (
                    tenant_id, form_key, name, description, recipients, cc, bcc, allowed_origins,
                    title, intro_text, submit_button_text, success_message, layout_columns,
                    honeypot_field, min_submit_seconds, max_per_hour_per_ip,
                    require_origin, duplicate_window_minutes, content_filter_enabled,
                    recaptcha_enabled, recaptcha_site_key, recaptcha_secret_enc, recaptcha_min_score,
                    autoreply_enabled, autoreply_to_field, store_submissions, is_active
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
                 RETURNING *`,
                [
                    tenant_id, form_key, name, src.description, src.recipients, src.cc, src.bcc,
                    // Origins and captcha keys belong to the source website, so
                    // the copy starts with none rather than inheriting an
                    // allowlist that would let the wrong site post.
                    [], src.title, src.intro_text, src.submit_button_text, src.success_message,
                    src.layout_columns, src.honeypot_field, src.min_submit_seconds, src.max_per_hour_per_ip,
                    // The copy starts locked down: it has no allowlist yet, so
                    // requiring an Origin is what keeps it from being a wide-open
                    // endpoint in the window before someone fills one in.
                    true, src.duplicate_window_minutes, src.content_filter_enabled,
                    false, null, null, src.recaptcha_min_score,
                    src.autoreply_enabled, src.autoreply_to_field, src.store_submissions, false
                ]
            );
            const row = inserted.rows[0];

            await client.query(
                `INSERT INTO form_fields (
                    form_id, field_key, label, field_type, placeholder, help_text, default_value,
                    is_required, min_length, max_length, min_value, max_value, pattern, pattern_message,
                    options, textarea_rows, col_span, sort_order, is_active)
                 SELECT $1, field_key, label, field_type, placeholder, help_text, default_value,
                    is_required, min_length, max_length, min_value, max_value, pattern, pattern_message,
                    options, textarea_rows, col_span, sort_order, is_active
                   FROM form_fields WHERE form_id = $2`,
                [row.id, sourceId]
            );

            await client.query(
                `INSERT INTO email_templates (form_id, template_type, subject, html_body, text_body, is_active)
                 SELECT $1, template_type, subject, html_body, text_body, is_active
                   FROM email_templates WHERE form_id = $2`,
                [row.id, sourceId]
            );

            return row;
        });

        logger.info('Form duplicated', { from: sourceId, to: newForm.id, by: req.email });
        res.status(201).json({
            status: 'success',
            message: 'Form copied. Set the allowed origins and recipients, then activate it.',
            data: { ...newForm, links: buildLinks(newForm.form_key) }
        });
    } catch (error) {
        handleServerError(res, error, 'form.duplicate');
    }
};

module.exports = { getAll, getOne, create, update, remove, duplicate };
