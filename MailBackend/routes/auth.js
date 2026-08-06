const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { login, logout, me, changePassword } = require('../models/auth');
const { verifyToken } = require('../middleware/auth');

// Tight limit on the login endpoint specifically — this is where credential
// stuffing lands, and legitimate users need only a handful of attempts.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({
        status: 'error',
        message: 'Too many login attempts. Please try again in 15 minutes.'
    })
});

router.post('/auth/login', loginLimiter, login);
router.post('/auth/logout', verifyToken, logout);
router.get('/auth/me', verifyToken, me);
router.post('/auth/change-password', verifyToken, changePassword);

module.exports = router;
