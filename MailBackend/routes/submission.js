const express = require('express');
const router = express.Router();
const submission = require('../models/submission');
const { verifyToken } = require('../middleware/auth');

router.get('/submissions', verifyToken, submission.getAll);
router.get('/submissions/stats', verifyToken, submission.stats);
router.get('/submissions/export', verifyToken, submission.exportCsv);
router.get('/submissions/:id', verifyToken, submission.getOne);
router.post('/submissions/:id/resend', verifyToken, submission.resend);
router.delete('/submissions/:id', verifyToken, submission.remove);

module.exports = router;
