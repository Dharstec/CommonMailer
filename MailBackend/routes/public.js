const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { submitForm } = require('../models/publicForm');

/**
 * Coarse in-memory limiter in front of the one public endpoint. The precise,
 * per-form limit lives in the database (helpers/antispam) — this one exists to
 * shed obvious floods before they reach Postgres.
 */
const submitLimiter = rateLimit({
    windowMs: (parseInt(process.env.PUBLIC_RATE_WINDOW_MINUTES, 10) || 15) * 60 * 1000,
    max: parseInt(process.env.PUBLIC_RATE_MAX, 10) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({
        status: 'error',
        message: 'Too many requests. Please try again later.'
    })
});

// The only endpoint a customer website ever calls.
router.post('/form/:formKey', submitLimiter, submitForm);

module.exports = router;
