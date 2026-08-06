/**
 * Reset an admin password from the command line.
 *
 *   node scripts/reset-admin-password.js you@example.com
 *   node scripts/reset-admin-password.js you@example.com 'MyNewPassword123'
 *
 * With no password given, a strong one is generated and printed. Run it from
 * the MailBackend directory so it picks up .env.
 *
 * Also creates the account if that email does not exist yet, which covers the
 * case where the first-boot admin was never captured.
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { applyDefaults, ensureSecrets } = require('../helpers/bootstrap');

applyDefaults();
ensureSecrets();

const pool = require('../middleware/db');

(async () => {
    const email = (process.argv[2] || '').toLowerCase().trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        console.error('\nUsage: node scripts/reset-admin-password.js <email> [new-password]\n');
        process.exit(1);
    }

    const supplied = process.argv[3];
    if (supplied && supplied.length < 8) {
        console.error('\nPassword must be at least 8 characters.\n');
        process.exit(1);
    }
    const password = supplied || crypto.randomBytes(12).toString('base64url');

    const hash = await bcrypt.hash(password, parseInt(process.env.SALT_ROUNDS, 10) || 10);

    // token is emptied so every existing session is invalidated — a password
    // reset is usually a response to losing control of the old one.
    const updated = await pool.query(
        `UPDATE admin_users
            SET password_hash = $1, token = '[]'::jsonb, is_active = true, updated_at = now()
          WHERE email = $2
        RETURNING id, name, email`,
        [hash, email]
    );

    let row = updated.rows[0];
    let created = false;

    if (!row) {
        const inserted = await pool.query(
            `INSERT INTO admin_users (name, email, password_hash, role)
             VALUES ($1, $2, $3, 'admin')
             RETURNING id, name, email`,
            [process.env.SEED_ADMIN_NAME || 'Administrator', email, hash]
        );
        row = inserted.rows[0];
        created = true;
    }

    console.log('');
    console.log(created ? '✅ Admin account created.' : '✅ Password reset.');
    console.log(`   Email:    ${row.email}`);
    console.log(`   Password: ${password}`);
    console.log(`   Panel:    ${process.env.FRONTEND_ORIGIN}`);
    if (!supplied) console.log('\n   Change it after logging in.');
    console.log('');

    await pool.end();
})().catch(async (err) => {
    console.error('\n❌ Failed:', err.message, '\n');
    await pool.end().catch(() => {});
    process.exit(1);
});
