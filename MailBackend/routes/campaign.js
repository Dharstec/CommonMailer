const express = require('express');
const router = express.Router();
const campaign = require('../models/campaign');
const campaignPublic = require('../models/campaignPublic');
const { verifyToken } = require('../middleware/auth');
const { validate, campaignSchema, campaignPreviewSchema, unsubscribeAddSchema } = require('../helpers/validator');

/**
 * Uploads arrive as the raw file (Content-Type: application/octet-stream) with
 * the name in ?filename=, so no multipart parser is needed. These limits are
 * the real ones; nginx only has to let the request through.
 *
 * Always mounted after verifyToken, so an anonymous caller is turned away
 * before 15 MB of their body is buffered.
 */
function rawBody(limit, tooLarge) {
    const parse = express.raw({ type: 'application/octet-stream', limit });
    return (req, res, next) => parse(req, res, (err) => {
        if (err && err.type === 'entity.too.large') {
            return res.status(413).json({ status: 'error', message: tooLarge });
        }
        return next(err);
    });
}

const listUpload = rawBody('5mb', 'The list is larger than 5 MB. Split it into smaller files.');
const fileUpload = rawBody('15mb', 'Attachments are limited to 15 MB per email.');

// Public: opened from inside a recipient's mail client. No login — the token is the key.
router.get('/c/:token/unsubscribe', campaignPublic.unsubscribePage);
router.post('/c/:token/unsubscribe', campaignPublic.unsubscribe);
router.get('/c/:token/open.gif', campaignPublic.openPixel);

router.get('/campaigns', verifyToken, campaign.getAll);
router.post('/campaigns', verifyToken, validate(campaignSchema), campaign.create);

// Registered before /campaigns/:id so "unsubscribes" is never read as an id.
router.get('/campaigns/unsubscribes', verifyToken, campaign.listUnsubscribes);
router.post('/campaigns/unsubscribes', verifyToken, validate(unsubscribeAddSchema), campaign.addUnsubscribes);
router.delete('/campaigns/unsubscribes/:unsubscribeId', verifyToken, campaign.removeUnsubscribe);

router.get('/campaigns/:id', verifyToken, campaign.getOne);
router.put('/campaigns/:id', verifyToken, validate(campaignSchema), campaign.update);
router.delete('/campaigns/:id', verifyToken, campaign.remove);
router.post('/campaigns/:id/duplicate', verifyToken, campaign.duplicate);

router.get('/campaigns/:id/recipients', verifyToken, campaign.listRecipients);
router.get('/campaigns/:id/recipients/export', verifyToken, campaign.exportRecipients);
router.post('/campaigns/:id/recipients', verifyToken, listUpload, campaign.uploadRecipients);
router.delete('/campaigns/:id/recipients', verifyToken, campaign.clearRecipients);

router.post('/campaigns/:id/attachments', verifyToken, fileUpload, campaign.uploadAttachment);
router.delete('/campaigns/:id/attachments/:attachmentId', verifyToken, campaign.removeAttachment);

router.post('/campaigns/:id/preview', verifyToken, validate(campaignPreviewSchema), campaign.preview);
router.post('/campaigns/:id/test', verifyToken, validate(campaignPreviewSchema), campaign.sendTest);
router.post('/campaigns/:id/start', verifyToken, campaign.start);
router.post('/campaigns/:id/pause', verifyToken, campaign.pause);
router.post('/campaigns/:id/cancel', verifyToken, campaign.cancel);
router.post('/campaigns/:id/retry-failed', verifyToken, campaign.retryFailed);

module.exports = router;
