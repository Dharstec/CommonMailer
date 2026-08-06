const POSTGRESQLService = require('../helpers/POSTGRES');
const { encrypt } = require('../helpers/crypto');
const mailer = require('../helpers/mailer');
const logger = require('../helpers/logger');

const handleServerError = (res, error, where) => {
    logger.error(`${where} failed`, { error: error.message, stack: error.stack });
    res.status(500).json({ status: 'error', message: 'Internal Server Error' });
};

const getAll = async (req, res) => {
    try {
        const data = await POSTGRESQLService.PostgresAny(
            `SELECT t.*,
                    (SELECT count(*)::int FROM forms f WHERE f.tenant_id = t.id) AS form_count,
                    (s.id IS NOT NULL) AS smtp_configured,
                    s.verified_at AS smtp_verified_at
               FROM tenants t
               LEFT JOIN tenant_smtp s ON s.tenant_id = t.id
              ORDER BY t.name ASC`,
            []
        );
        res.json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'tenant.getAll');
    }
};

const getOne = async (req, res) => {
    try {
        const rows = await POSTGRESQLService.PostgresAny(`SELECT * FROM tenants WHERE id = $1`, [req.params.id]);
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'Customer not found' });

        // password_enc is deliberately excluded — a stored secret has no reason
        // to travel back to the browser, even for an authenticated admin.
        const smtp = await POSTGRESQLService.PostgresAny(
            `SELECT id, tenant_id, host, port, secure, username, from_name, from_email,
                    reply_to, is_active, verified_at
               FROM tenant_smtp WHERE tenant_id = $1`,
            [req.params.id]
        );

        res.json({ status: 'success', data: { ...rows[0], smtp: smtp[0] || null } });
    } catch (error) {
        handleServerError(res, error, 'tenant.getOne');
    }
};

const create = async (req, res) => {
    try {
        const exists = await POSTGRESQLService.PostgresAny(`SELECT id FROM tenants WHERE slug = $1`, [req.body.slug]);
        if (exists.length) {
            return res.status(409).json({ status: 'error', message: 'That slug is already used by another customer.' });
        }

        const data = await POSTGRESQLService.PostgresInsert('tenants', req.body);
        logger.info('Tenant created', { id: data.id, slug: data.slug, by: req.email });
        res.status(201).json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'tenant.create');
    }
};

const update = async (req, res) => {
    try {
        const exists = await POSTGRESQLService.PostgresAny(
            `SELECT id FROM tenants WHERE slug = $1 AND id <> $2`, [req.body.slug, req.params.id]
        );
        if (exists.length) {
            return res.status(409).json({ status: 'error', message: 'That slug is already used by another customer.' });
        }

        const data = await POSTGRESQLService.PostgresUpdate(
            'tenants', { ...req.body, updated_at: new Date() }, req.params.id
        );
        if (!data) return res.status(404).json({ status: 'error', message: 'Customer not found' });

        res.json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'tenant.update');
    }
};

const remove = async (req, res) => {
    try {
        await POSTGRESQLService.PostgresDelete('tenants', 'id', req.params.id);
        mailer.invalidate(Number(req.params.id));
        logger.warn('Tenant deleted', { id: req.params.id, by: req.email });
        res.json({ status: 'success', message: 'Customer deleted.' });
    } catch (error) {
        handleServerError(res, error, 'tenant.remove');
    }
};

/**
 * Saves the customer's sending account.
 *
 * A blank password means "keep what is stored", so an admin can edit the From
 * name without re-typing the mailbox password — and so the UI never needs to
 * hold the real password to send it back.
 */
const saveSmtp = async (req, res) => {
    try {
        const tenantId = Number(req.params.id);
        const tenant = await POSTGRESQLService.PostgresAny(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
        if (!tenant.length) return res.status(404).json({ status: 'error', message: 'Customer not found' });

        const existing = await POSTGRESQLService.PostgresAny(
            `SELECT id, password_enc FROM tenant_smtp WHERE tenant_id = $1`, [tenantId]
        );

        const { password, ...rest } = req.body;

        let passwordEnc;
        if (password) {
            passwordEnc = encrypt(password);
        } else if (existing.length) {
            passwordEnc = existing[0].password_enc;
        } else {
            return res.status(400).json({ status: 'error', message: 'SMTP password is required.' });
        }

        const values = {
            ...rest,
            tenant_id: tenantId,
            password_enc: passwordEnc,
            // Credentials changed, so the previous "verified" result no longer
            // proves anything.
            verified_at: null,
            updated_at: new Date()
        };

        let data;
        if (existing.length) {
            data = await POSTGRESQLService.PostgresUpdate('tenant_smtp', values, existing[0].id);
        } else {
            data = await POSTGRESQLService.PostgresInsert('tenant_smtp', values);
        }

        // Drop the cached transport so the very next send uses the new details.
        mailer.invalidate(tenantId);

        delete data.password_enc;
        logger.info('SMTP settings saved', { tenantId, by: req.email });
        res.json({ status: 'success', data });
    } catch (error) {
        handleServerError(res, error, 'tenant.saveSmtp');
    }
};

/** Opens a real SMTP connection and authenticates, without sending anything. */
const testSmtp = async (req, res) => {
    try {
        await mailer.verifyConnection(Number(req.params.id));
        res.json({ status: 'success', message: 'SMTP connection successful.' });
    } catch (error) {
        logger.warn('SMTP test failed', { tenantId: req.params.id, error: error.message });
        res.status(400).json({ status: 'error', message: `SMTP test failed: ${error.message}` });
    }
};

/** Sends a real message so you can confirm delivery, not just authentication. */
const sendTestMail = async (req, res) => {
    try {
        const tenantId = Number(req.params.id);
        const to = req.body && req.body.to;
        if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) {
            return res.status(400).json({ status: 'error', message: 'A valid recipient email is required.' });
        }

        await mailer.sendMail(tenantId, {
            to: [String(to)],
            subject: 'CommonMailer test message',
            html: '<p>This is a test message from CommonMailer. If you can read this, the SMTP settings for this customer are working.</p>',
            text: 'This is a test message from CommonMailer. If you can read this, the SMTP settings for this customer are working.'
        });

        res.json({ status: 'success', message: `Test email sent to ${to}.` });
    } catch (error) {
        logger.warn('Test mail failed', { tenantId: req.params.id, error: error.message });
        res.status(400).json({ status: 'error', message: `Could not send: ${error.message}` });
    }
};

module.exports = { getAll, getOne, create, update, remove, saveSmtp, testSmtp, sendTestMail };
