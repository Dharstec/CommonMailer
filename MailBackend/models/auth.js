const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const POSTGRESQLService = require('../helpers/POSTGRES');
const logger = require('../helpers/logger');
const { recordFirstLogin } = require('../helpers/bootstrap');
require('dotenv').config();

const MAX_SESSIONS = 5;

/**
 * Creates the first admin account on an empty database so a fresh deployment is
 * reachable. It only ever runs when admin_users is empty — an existing
 * installation is never touched, and the seed password can be rotated from the
 * panel afterwards.
 */
async function seedFirstAdmin() {
    const existing = await POSTGRESQLService.PostgresAny(`SELECT count(*)::int AS total FROM admin_users`, []);
    if (existing[0].total > 0) return;

    const email = process.env.SEED_ADMIN_EMAIL;
    if (!email) {
        console.warn('⚠️  No admin user exists and SEED_ADMIN_EMAIL is not set — nobody can log in.');
        return;
    }

    // A password in .env is optional: generating one means there is no weak
    // default to forget about, and no credential sitting in a config file.
    const generated = !process.env.SEED_ADMIN_PASSWORD;
    const password = process.env.SEED_ADMIN_PASSWORD
        || crypto.randomBytes(12).toString('base64url');

    const hash = await bcrypt.hash(password, parseInt(process.env.SALT_ROUNDS, 10) || 10);
    await POSTGRESQLService.PostgresInsert('admin_users', {
        name: process.env.SEED_ADMIN_NAME || 'Administrator',
        email: email.toLowerCase().trim(),
        password_hash: hash,
        role: 'admin'
    });

    if (generated) {
        const file = recordFirstLogin(email, password);
        console.log('');
        console.log('✅ First admin account created.');
        console.log(`   Email:    ${email}`);
        console.log(`   Password: ${password}`);
        console.log(`   Also written to ${file} (readable only by you).`);
        console.log('   Change it after logging in, then delete that file.');
        console.log('');
    } else {
        console.log(`✅ First admin created: ${email} — change this password after logging in.`);
    }
}

const login = async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ status: 'error', message: 'Email and password are required.' });
        }

        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT * FROM admin_users WHERE email = $1`,
            [String(email).toLowerCase().trim()]
        );

        // One message for "no such user" and "wrong password" so the endpoint
        // cannot be used to discover which addresses are registered.
        const invalid = { status: 'error', message: 'Invalid email or password.' };
        if (!rows.length) {
            await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
            return res.status(401).json(invalid);
        }

        const user = rows[0];
        if (!user.is_active) {
            return res.status(403).json({ status: 'error', message: 'Account is disabled.' });
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
            logger.warn('Failed admin login', { email, ip: req.ip });
            return res.status(401).json(invalid);
        }

        const token = jwt.sign(
            { user_id: user.id, email: user.email, role: user.role },
            process.env.SECRET_CODE,
            { expiresIn: process.env.TOKEN_EXPIRY || '8h' }
        );

        let tokenList = user.token || [];
        if (typeof tokenList === 'string') {
            try { tokenList = JSON.parse(tokenList); } catch (e) { tokenList = []; }
        }
        // Keep the newest few sessions so logging in on a new device does not
        // silently kick the others, but the list cannot grow without bound.
        tokenList = [...tokenList, token].slice(-MAX_SESSIONS);

        await POSTGRESQLService.PostgresAny(
            `UPDATE admin_users SET token = $1, last_login_at = now() WHERE id = $2`,
            [JSON.stringify(tokenList), user.id]
        );

        logger.info('Admin login', { email: user.email, ip: req.ip });

        res.json({
            status: 'success',
            data: {
                token,
                user: { id: user.id, name: user.name, email: user.email, role: user.role }
            }
        });
    } catch (error) {
        logger.error('login failed', { error: error.message });
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
};

const logout = async (req, res) => {
    try {
        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT token FROM admin_users WHERE id = $1`, [req.user_id]
        );
        let tokenList = rows.length ? (rows[0].token || []) : [];
        if (typeof tokenList === 'string') {
            try { tokenList = JSON.parse(tokenList); } catch (e) { tokenList = []; }
        }
        tokenList = tokenList.filter((t) => t !== req.token);

        await POSTGRESQLService.PostgresAny(
            `UPDATE admin_users SET token = $1 WHERE id = $2`,
            [JSON.stringify(tokenList), req.user_id]
        );

        res.json({ status: 'success', message: 'Logged out.' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
};

const me = async (req, res) => {
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT id, name, email, role, last_login_at FROM admin_users WHERE id = $1`,
        [req.user_id]
    );
    res.json({ status: 'success', data: rows[0] || null });
};

const changePassword = async (req, res) => {
    try {
        const { current_password, new_password } = req.body || {};
        if (!current_password || !new_password) {
            return res.status(400).json({ status: 'error', message: 'Both passwords are required.' });
        }
        if (String(new_password).length < 8) {
            return res.status(400).json({ status: 'error', message: 'New password must be at least 8 characters.' });
        }

        const rows = await POSTGRESQLService.PostgresAny(
            `SELECT password_hash FROM admin_users WHERE id = $1`, [req.user_id]
        );
        if (!rows.length || !(await bcrypt.compare(current_password, rows[0].password_hash))) {
            return res.status(401).json({ status: 'error', message: 'Current password is incorrect.' });
        }

        const hash = await bcrypt.hash(new_password, parseInt(process.env.SALT_ROUNDS, 10) || 10);
        // Changing a password ends every session, including this one — a
        // password change is usually a response to suspected compromise.
        await POSTGRESQLService.PostgresAny(
            `UPDATE admin_users SET password_hash = $1, token = '[]'::jsonb, updated_at = now() WHERE id = $2`,
            [hash, req.user_id]
        );

        res.json({ status: 'success', message: 'Password changed. Please log in again.' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
};

module.exports = { login, logout, me, changePassword, seedFirstAdmin };
