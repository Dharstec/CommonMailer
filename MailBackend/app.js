require('dotenv').config();

// Config first, before anything else is required. Requiring the routes builds
// the database pool from process.env, so the defaults have to be in place by
// then — otherwise the pool is created with undefined host/user/password and
// every query fails for a reason that has nothing to do with the query.
const { applyDefaults, ensureSecrets, ensureDatabase } = require('./helpers/bootstrap');
applyDefaults();
ensureSecrets();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');

const logger = require('./helpers/logger');
const { assertKeyReady } = require('./helpers/crypto');

const app = express();

const ADMIN_ORIGINS = (process.env.FRONTEND_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);

/**
 * Two different CORS policies in one service.
 *
 * The admin API is locked to the origins in FRONTEND_ORIGIN. The form submit
 * endpoint cannot be, because its callers are customer websites we onboard from
 * the panel without redeploying — so it reflects any origin here and enforces
 * the form's own allowlist inside the handler, which is where the form key (and
 * therefore the allowlist) is actually known. A disallowed site gets a clean
 * 403 from the handler rather than an opaque CORS failure.
 */
const corsOptionsDelegate = (req, callback) => {
    if (req.path.startsWith('/api/form/')) {
        return callback(null, {
            origin: true,
            methods: ['POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type'],
            maxAge: 600,
            optionsSuccessStatus: 204
        });
    }

    return callback(null, {
        origin: (origin, cb) => {
            if (!origin || ADMIN_ORIGINS.includes(origin)) return cb(null, true);
            return cb(new Error('Request not allowed'));
        },
        credentials: true,
        optionsSuccessStatus: 200
    });
};

// Behind nginx/pm2 — required for req.ip and the rate limiters to see the real
// client address rather than the proxy's.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// This service returns JSON only — it serves no HTML and no scripts to third
// parties, so the strictest defaults apply.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'none'"],
            frameAncestors: ["'none'"]
        }
    }
}));

app.use(cors(corsOptionsDelegate));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ limit: '1mb', extended: true }));

// Global flood protection. Route-level limiters (login, public submit) are
// tighter; this one only catches broad abuse.
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ status: 'error', message: 'Too many requests, please try again later.' })
}));

app.use((req, res, next) => {
    // Optional Host allowlist. Left blank in .env it is skipped, so the service
    // still works behind a proxy whose Host you have not enumerated.
    const allowedHosts = (process.env.BACKEND_HOST || '').split(',').map((h) => h.trim()).filter(Boolean);
    if (allowedHosts.length && !allowedHosts.includes(req.headers.host)) {
        logger.warn('Blocked: invalid Host header', { ip: req.ip, host: req.headers.host, path: req.originalUrl });
        return res.status(400).json({ status: 'error', message: 'Invalid Host' });
    }

    logger.info(`${req.method} ${req.originalUrl}`, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        origin: req.headers.origin
    });

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '-1');

    next();
});

require('./baseroute')(app);

app.use((req, res) => {
    res.status(404).json({ status: 'error', message: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
    if (err && err.message === 'Request not allowed') {
        return res.status(403).json({ status: 'error', message: 'Origin not allowed' });
    }
    const status = err.status || 500;
    if (status >= 500) {
        logger.error(err.message, { stack: err.stack });
    } else {
        logger.warn(err.message, { stack: err.stack });
    }
    // Internal messages stay in the log; the client gets a generic string so a
    // stack trace or SQL fragment can never leak through an error path.
    res.status(status).json({
        status: 'error',
        message: status >= 500 ? 'Internal Server Error' : (err.message || 'Request failed')
    });
});

/**
 * Boot sequence. Each step assumes the previous one succeeded, so the order is
 * load-bearing: config before secrets (secrets are written next to the app),
 * secrets before any encryption, the database before anything queries it.
 *
 * migrate and auth are required lazily inside the function because requiring
 * them builds the connection pool, and on a fresh box the database does not
 * exist until ensureDatabase() has run.
 */
(async () => {
    try {
        assertKeyReady();

        await ensureDatabase();

        const { runMigrations } = require('./helpers/migrate');
        const { seedFirstAdmin } = require('./models/auth');

        await runMigrations();
        await seedFirstAdmin();

        app.listen(process.env.PORT, () => {
            console.log(`🚀 CommonMailer running on port ${process.env.PORT}`);
            console.log(`   API      ${process.env.PUBLIC_BASE_URL}`);
            console.log(`   Panel    ${process.env.FRONTEND_ORIGIN}`);
        });
    } catch (err) {
        console.error('\n❌ Startup failed:\n');
        console.error(err.message);
        console.error('');
        process.exit(1);
    }
})();
