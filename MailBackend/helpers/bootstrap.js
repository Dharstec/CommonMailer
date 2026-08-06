/**
 * Everything the server needs to bring itself up on a fresh machine.
 *
 * Runs before anything touches the database, in this order:
 *   1. defaults      — fill in every env var except the handful you must set
 *   2. secrets       — generate and persist the signing/encryption keys once
 *   3. database      — CREATE DATABASE if it does not exist yet
 * Migrations and the first admin then run from app.js.
 *
 * The goal is that a fresh EC2 box needs only three values in .env
 * (DB password, API URL, panel URL) and the rest takes care of itself.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SECRETS_FILE = path.join(__dirname, '..', '.secrets.json');
const ADMIN_FILE = path.join(__dirname, '..', 'FIRST_LOGIN.txt');

/** Values that have a sensible answer on every deployment. */
const DEFAULTS = {
    PORT: '4100',
    NODE_ENV: 'production',

    POSTGRESQL_HOST: 'localhost',
    POSTGRESQL_PORT: '5432',
    POSTGRESQL_USER: 'commonmailer',
    POSTGRESQL_DATABASE: 'common_mailer',
    // The maintenance database we connect to in order to CREATE DATABASE.
    POSTGRESQL_ADMIN_DATABASE: 'postgres',

    TOKEN_EXPIRY: '8h',
    SALT_ROUNDS: '10',

    PUBLIC_RATE_WINDOW_MINUTES: '15',
    PUBLIC_RATE_MAX: '60',

    SEED_ADMIN_NAME: 'Administrator'
};

/**
 * The only values that genuinely cannot be guessed on a real deployment.
 *
 * Enforced in production only: on a laptop, Postgres usually trusts local
 * connections and the URLs are localhost, so demanding them there would mean
 * writing a .env just to run the thing.
 */
const REQUIRED_IN_PRODUCTION = [
    ['POSTGRESQL_PASSWORD', 'the database password you chose during setup'],
    ['PUBLIC_BASE_URL', 'the public URL of this API, e.g. https://mailer.dharstec.com'],
    ['FRONTEND_ORIGIN', 'the admin panel URL, e.g. https://d1234.cloudfront.net']
];

function applyDefaults() {
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!process.env[key]) process.env[key] = value;
    }

    if (process.env.NODE_ENV === 'production') {
        const missing = REQUIRED_IN_PRODUCTION.filter(([key]) => !process.env[key]);
        if (missing.length) {
            throw new Error(
                'Missing required values in .env:\n\n' +
                missing.map(([key, why]) => `  ${key}\n      ${why}`).join('\n\n') +
                '\n\n  Copy .env.example to .env and fill these in. .env is gitignored —\n' +
                '  it stays on this server and is never committed.'
            );
        }
    } else {
        // Local development falls back to localhost so `npm start` just works.
        if (!process.env.PUBLIC_BASE_URL) process.env.PUBLIC_BASE_URL = `http://localhost:${process.env.PORT}`;
        if (!process.env.FRONTEND_ORIGIN) process.env.FRONTEND_ORIGIN = 'http://localhost:4200';
    }

    // The Host allowlist is just the hostnames we already know about, so it does
    // not need its own entry in .env.
    if (!process.env.BACKEND_HOST) {
        const hosts = new Set();
        for (const url of [process.env.PUBLIC_BASE_URL]) {
            try {
                const parsed = new URL(url);
                hosts.add(parsed.host);
            } catch (err) { /* ignore an unparseable URL — validated below */ }
        }
        hosts.add(`localhost:${process.env.PORT}`);
        hosts.add(`127.0.0.1:${process.env.PORT}`);
        process.env.BACKEND_HOST = [...hosts].join(',');
    }

    try {
        // eslint-disable-next-line no-new
        new URL(process.env.PUBLIC_BASE_URL);
    } catch (err) {
        throw new Error(`PUBLIC_BASE_URL is not a valid URL: ${process.env.PUBLIC_BASE_URL}`);
    }

    if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_BASE_URL.startsWith('https://')) {
        console.warn(
            '⚠️  PUBLIC_BASE_URL is not https. A CloudFront-hosted panel is served over\n' +
            '    https, and browsers block https pages from calling http APIs, so the\n' +
            '    panel will fail to reach this server until TLS is in front of it.'
        );
    }
}

/**
 * Signing and encryption keys.
 *
 * Generated once and written to .secrets.json (gitignored, 0600) rather than
 * being regenerated per boot: a new ENCRYPTION_KEY would make every stored SMTP
 * password undecryptable, and a new SECRET_CODE would log everyone out.
 * An env var always wins, so you can move to a secrets manager later without
 * changing any code.
 */
function ensureSecrets() {
    const needed = ['ENCRYPTION_KEY', 'SECRET_CODE'];
    const fromEnv = needed.filter((key) => process.env[key]);

    let stored = {};
    if (fs.existsSync(SECRETS_FILE)) {
        try {
            stored = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
        } catch (err) {
            throw new Error(`${SECRETS_FILE} exists but is not readable JSON. Fix or delete it.`);
        }
    }

    let generatedAny = false;
    for (const key of needed) {
        if (process.env[key]) continue;
        if (stored[key]) {
            process.env[key] = stored[key];
            continue;
        }
        stored[key] = key === 'ENCRYPTION_KEY'
            ? crypto.randomBytes(32).toString('hex')     // AES-256 needs 32 bytes
            : crypto.randomBytes(48).toString('base64url');
        process.env[key] = stored[key];
        generatedAny = true;
    }

    if (generatedAny) {
        fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
        fs.chmodSync(SECRETS_FILE, 0o600);
        console.log(`🔑 Generated missing secrets and saved them to ${SECRETS_FILE}`);
        console.log('   BACK THIS FILE UP. Losing ENCRYPTION_KEY means every stored SMTP');
        console.log('   password has to be re-entered in the admin panel.');
    }

    if (fromEnv.length) {
        console.log(`🔑 Using ${fromEnv.join(' and ')} from the environment.`);
    }
}

/**
 * Creates the application database if it is not there yet.
 *
 * Connects to the `postgres` maintenance database, because you cannot create a
 * database from inside the one you are creating. Requires the app's Postgres
 * role to have CREATEDB — setup-ec2.sh grants that. If it does not, the error
 * says exactly which SQL to run by hand.
 */
async function ensureDatabase() {
    const target = process.env.POSTGRESQL_DATABASE;

    const client = new Client({
        host: process.env.POSTGRESQL_HOST,
        port: parseInt(process.env.POSTGRESQL_PORT, 10),
        user: process.env.POSTGRESQL_USER,
        password: process.env.POSTGRESQL_PASSWORD,
        database: process.env.POSTGRESQL_ADMIN_DATABASE,
        connectionTimeoutMillis: 8000
    });

    try {
        await client.connect();
    } catch (err) {
        throw new Error(
            `Could not reach PostgreSQL at ${process.env.POSTGRESQL_HOST}:${process.env.POSTGRESQL_PORT} ` +
            `as user "${process.env.POSTGRESQL_USER}".\n  ${err.message}\n` +
            '  Check POSTGRESQL_PASSWORD in .env, and that PostgreSQL is running.'
        );
    }

    try {
        const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
        if (exists.rowCount > 0) return false;

        // The database name comes from our own config, never from a request, but
        // it still cannot be a bound parameter in CREATE DATABASE — so quote it
        // properly rather than interpolating raw.
        const quoted = '"' + String(target).replace(/"/g, '""') + '"';
        await client.query(`CREATE DATABASE ${quoted}`);
        console.log(`🗄️  Created database "${target}"`);
        return true;
    } catch (err) {
        if (err.code === '42501') {
            throw new Error(
                `Database "${target}" does not exist and user "${process.env.POSTGRESQL_USER}" ` +
                'may not create it.\n  Run this once as the postgres superuser:\n' +
                `    sudo -u postgres psql -c 'ALTER ROLE ${process.env.POSTGRESQL_USER} CREATEDB;'`
            );
        }
        // Two servers booting at once can both pass the existence check.
        if (err.code === '42P04') return false;
        throw err;
    } finally {
        await client.end().catch(() => {});
    }
}

/**
 * Writes the generated first-login password somewhere the operator can read it,
 * instead of only into a log that may be shipped off the box.
 */
function recordFirstLogin(email, password) {
    const body =
        'CommonMailer — first admin account\n' +
        '==================================\n\n' +
        `Panel:    ${process.env.FRONTEND_ORIGIN}\n` +
        `Email:    ${email}\n` +
        `Password: ${password}\n\n` +
        'Change this password after logging in (top-right menu -> Change password),\n' +
        'then delete this file:\n' +
        `  rm ${ADMIN_FILE}\n`;

    fs.writeFileSync(ADMIN_FILE, body, { mode: 0o600 });
    fs.chmodSync(ADMIN_FILE, 0o600);
    return ADMIN_FILE;
}

module.exports = { applyDefaults, ensureSecrets, ensureDatabase, recordFirstLogin, SECRETS_FILE, ADMIN_FILE };
