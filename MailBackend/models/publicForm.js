/**
 * The one public endpoint every customer website calls.
 *
 *   POST /api/form/:formKey   -> validate, store, mail
 *
 * Nothing here is customer-specific in code. The handler reads the form
 * definition from the database on every request, so onboarding a new website is
 * rows in the admin panel, not a deploy.
 */
const POSTGRESQLService = require('../helpers/POSTGRES');
const { buildSchema } = require('../helpers/dynamicValidator');
const templateHelper = require('../helpers/template');
const mailer = require('../helpers/mailer');
const antispam = require('../helpers/antispam');
const logger = require('../helpers/logger');

/** Loads a form plus its tenant in one round trip. */
async function loadForm(formKey) {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT f.*,
                t.name  AS tenant_name,
                t.slug  AS tenant_slug,
                t.is_active AS tenant_active
           FROM forms f
           JOIN tenants t ON t.id = f.tenant_id
          WHERE f.form_key = $1`,
        [formKey]
    );
    return rows[0] || null;
}

async function loadFields(formId) {
    return POSTGRESQLService.PostgresAny(
        `SELECT * FROM form_fields
          WHERE form_id = $1 AND is_active = true
          ORDER BY sort_order ASC, id ASC`,
        [formId]
    );
}

async function loadTemplate(formId, type) {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT * FROM email_templates
          WHERE form_id = $1 AND template_type = $2 AND is_active = true`,
        [formId, type]
    );
    return rows[0] || null;
}

/**
 * Bots get the same success response a human gets.
 *
 * Returning 403 on a honeypot hit tells the author exactly which field to leave
 * blank next time. Silently accepting and discarding costs them a retry loop and
 * leaves us an audit row.
 */
async function fakeSuccess(form, ip, reason, req, data) {
    logger.warn('Submission rejected as spam', { formKey: form.form_key, ip, reason });
    if (form.store_submissions) {
        await POSTGRESQLService.PostgresInsert('submissions', {
            form_id: form.id,
            tenant_id: form.tenant_id,
            data: JSON.stringify(data || {}),
            ip,
            user_agent: (req.headers['user-agent'] || '').slice(0, 500),
            referer: (req.headers.referer || '').slice(0, 500),
            origin: (req.headers.origin || '').slice(0, 300),
            mail_status: 'spam',
            spam_reason: reason
        }).catch((err) => logger.error('Could not record spam submission', { error: err.message }));
    }
    return { status: 'success', message: form.success_message };
}

const submitForm = async (req, res) => {
    const ip = antispam.clientIp(req);

    try {
        const form = await loadForm(req.params.formKey);

        if (!form || !form.is_active || !form.tenant_active) {
            return res.status(404).json({ status: 'error', message: 'Form not found' });
        }

        // --- Layer 1: is this website allowed to post here at all? -----------
        const originReason = antispam.checkOrigin(req.headers.origin, form.allowed_origins);
        if (originReason) {
            logger.warn('Submit from disallowed origin', {
                formKey: form.form_key, origin: req.headers.origin, ip, reason: originReason
            });
            return res.status(403).json({ status: 'error', message: 'This form is not enabled for this website.' });
        }

        const body = req.body || {};

        // --- Layer 2: cheap bot traps, before touching the DB ---------------
        const trapReason = antispam.checkHoneypot(body, form.honeypot_field)
            || antispam.checkTiming(body, form.min_submit_seconds);
        if (trapReason) {
            return res.json(await fakeSuccess(form, ip, trapReason, req, null));
        }

        // --- Layer 3: per-form throttle -------------------------------------
        const rateReason = await antispam.checkRateLimit(form.id, ip, form.max_per_hour_per_ip);
        if (rateReason) {
            logger.warn('Per-form rate limit hit', { formKey: form.form_key, ip });
            return res.status(429).json({
                status: 'error',
                message: 'Too many submissions from your network. Please try again later.'
            });
        }

        // --- Layer 4: validate against the schema built from the DB ---------
        const fields = await loadFields(form.id);
        const schema = buildSchema(fields, form);
        const { error, value } = schema.validate(body, { abortEarly: false, stripUnknown: false, convert: true });

        if (error) {
            return res.status(400).json({
                status: 'error',
                message: 'Please correct the highlighted fields.',
                errors: error.details.map((d) => ({ field: d.path[0], message: d.message }))
            });
        }

        // --- Layer 5: captcha (network call, so it runs last) ---------------
        const captchaReason = await antispam.checkRecaptcha(form, body._captcha, ip);
        if (captchaReason) {
            return res.json(await fakeSuccess(form, ip, captchaReason, req, value));
        }

        // Strip control keys so they never reach the mail template or storage.
        const data = { ...value };
        delete data._ts;
        delete data._captcha;
        delete data[form.honeypot_field];

        // --- Store first, mail second ---------------------------------------
        // The submission is the customer's business record; SMTP is the flaky
        // part. Persisting before sending means a mail outage loses a
        // notification, never the enquiry itself.
        let submissionId = null;
        if (form.store_submissions) {
            const row = await POSTGRESQLService.PostgresInsert('submissions', {
                form_id: form.id,
                tenant_id: form.tenant_id,
                data: JSON.stringify(data),
                ip,
                user_agent: (req.headers['user-agent'] || '').slice(0, 500),
                referer: (req.headers.referer || '').slice(0, 500),
                origin: (req.headers.origin || '').slice(0, 300),
                mail_status: 'pending'
            });
            submissionId = row.id;
        }

        const meta = {
            date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            ip,
            form_name: form.name,
            tenant_name: form.tenant_name
        };

        // Reply-To points at the visitor when the form collects an email, so the
        // customer can hit Reply directly.
        const visitorEmail = form.autoreply_to_field ? data[form.autoreply_to_field] : null;
        const replyTo = visitorEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(visitorEmail))
            ? String(visitorEmail)
            : null;

        try {
            // Notification to the customer's inbox.
            if (form.recipients && form.recipients.length) {
                const tpl = (await loadTemplate(form.id, 'admin')) || templateHelper.DEFAULTS.admin;
                const info = await mailer.sendMail(form.tenant_id, {
                    to: form.recipients,
                    cc: form.cc,
                    bcc: form.bcc,
                    replyTo,
                    subject: templateHelper.sanitizeHeader(
                        templateHelper.render(tpl.subject, data, fields, meta, { escape: false })
                    ),
                    html: templateHelper.wrapHtml(
                        templateHelper.render(tpl.html_body, data, fields, meta),
                        form.name
                    ),
                    text: templateHelper.render(tpl.text_body, data, fields, meta, { escape: false })
                });

                if (submissionId) {
                    await POSTGRESQLService.PostgresAny(
                        `UPDATE submissions SET mail_status = 'sent', message_id = $1 WHERE id = $2`,
                        [info.messageId, submissionId]
                    );
                }
            }

            // Auto-reply to the visitor, best effort.
            if (form.autoreply_enabled && replyTo) {
                const tpl = (await loadTemplate(form.id, 'autoreply')) || templateHelper.DEFAULTS.autoreply;
                await mailer.sendMail(form.tenant_id, {
                    to: [replyTo],
                    subject: templateHelper.sanitizeHeader(
                        templateHelper.render(tpl.subject, data, fields, meta, { escape: false })
                    ),
                    html: templateHelper.wrapHtml(
                        templateHelper.render(tpl.html_body, data, fields, meta),
                        form.tenant_name
                    ),
                    text: templateHelper.render(tpl.text_body, data, fields, meta, { escape: false })
                }).catch((err) => {
                    logger.warn('Auto-reply failed', { formKey: form.form_key, error: err.message });
                });
            }
        } catch (mailError) {
            logger.error('Notification mail failed', {
                formKey: form.form_key, error: mailError.message
            });
            if (submissionId) {
                await POSTGRESQLService.PostgresAny(
                    `UPDATE submissions SET mail_status = 'failed', mail_error = $1 WHERE id = $2`,
                    [String(mailError.message).slice(0, 500), submissionId]
                );
            }
            // The enquiry is saved and visible in the admin panel, so the visitor
            // is told it went through. The delivery failure is ours to chase.
        }

        res.json({ status: 'success', message: form.success_message });
    } catch (error) {
        logger.error('submitForm failed', { error: error.message, stack: error.stack, ip });
        res.status(500).json({ status: 'error', message: 'Something went wrong. Please try again.' });
    }
};

module.exports = { submitForm };
