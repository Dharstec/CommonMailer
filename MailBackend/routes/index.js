const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.json({ status: 'success', service: 'CommonMailer', version: '1.0.0' });
});

router.get('/health', (req, res) => {
    res.json({ status: 'success', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

module.exports = router;
