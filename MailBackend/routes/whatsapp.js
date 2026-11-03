const express = require('express');
const router = express.Router();
const whatsapp = require('../models/whatsapp');
const webhook = require('../models/whatsappWebhook');
const { verifyToken } = require('../middleware/auth');
const {
    validate, waAccountSchema, waCampaignSchema, waTestSchema, waTemplateSchema, waOptoutAddSchema, waReplySchema
} = require('../helpers/validator');

/** Raw uploads, as for email campaigns: the file is the body, the name is in ?filename=. */
function rawBody(limit, tooLarge) {
    const parse = express.raw({ type: 'application/octet-stream', limit });
    return (req, res, next) => parse(req, res, (err) => {
        if (err && err.type === 'entity.too.large') return res.status(413).json({ status: 'error', message: tooLarge });
        return next(err);
    });
}

const listUpload = rawBody('5mb', 'The list is larger than 5 MB. Split it into smaller files.');
const imageUpload = rawBody('5mb', 'Pictures are limited to 5 MB.');

// Public: Meta's server calls these. The signature is checked inside.
router.get('/wa/webhook', webhook.verify);
router.post('/wa/webhook', webhook.receive);

// Connecting a customer's WhatsApp number.
router.get('/whatsapp/accounts', verifyToken, whatsapp.listAccounts);
router.get('/whatsapp/accounts/:tenantId', verifyToken, whatsapp.getAccount);
router.put('/whatsapp/accounts/:tenantId', verifyToken, validate(waAccountSchema), whatsapp.saveAccount);
router.delete('/whatsapp/accounts/:tenantId', verifyToken, whatsapp.removeAccount);
router.post('/whatsapp/accounts/:tenantId/check', verifyToken, whatsapp.checkAccount);
router.post('/whatsapp/accounts/:tenantId/test', verifyToken, whatsapp.sendAccountTest);
router.post('/whatsapp/accounts/:tenantId/images', verifyToken, imageUpload, whatsapp.uploadImage);
router.get('/whatsapp/accounts/:tenantId/templates', verifyToken, whatsapp.listTemplates);
router.post('/whatsapp/accounts/:tenantId/templates', verifyToken, validate(waTemplateSchema), whatsapp.createTemplate);

// The do-not-message list. Before /wa-campaigns/:id so "optouts" is never read as an id.
router.get('/wa-campaigns/optouts', verifyToken, whatsapp.listOptouts);
router.post('/wa-campaigns/optouts', verifyToken, validate(waOptoutAddSchema), whatsapp.addOptouts);
router.delete('/wa-campaigns/optouts/:optoutId', verifyToken, whatsapp.removeOptout);

router.get('/wa-campaigns', verifyToken, whatsapp.getAll);
router.post('/wa-campaigns', verifyToken, validate(waCampaignSchema), whatsapp.create);
router.get('/wa-campaigns/:id', verifyToken, whatsapp.getOne);
router.put('/wa-campaigns/:id', verifyToken, validate(waCampaignSchema), whatsapp.update);
router.delete('/wa-campaigns/:id', verifyToken, whatsapp.remove);
router.post('/wa-campaigns/:id/duplicate', verifyToken, whatsapp.duplicate);

router.get('/wa-campaigns/:id/recipients', verifyToken, whatsapp.listRecipients);
router.get('/wa-campaigns/:id/recipients/export', verifyToken, whatsapp.exportRecipients);
router.post('/wa-campaigns/:id/recipients', verifyToken, listUpload, whatsapp.uploadRecipients);
router.delete('/wa-campaigns/:id/recipients', verifyToken, whatsapp.clearRecipients);
router.delete('/wa-campaigns/:id/recipients/:recipientId', verifyToken, whatsapp.removeRecipient);

router.post('/wa-campaigns/:id/test', verifyToken, validate(waTestSchema), whatsapp.sendTest);
router.post('/wa-campaigns/:id/start', verifyToken, whatsapp.start);
router.post('/wa-campaigns/:id/pause', verifyToken, whatsapp.pause);
router.post('/wa-campaigns/:id/cancel', verifyToken, whatsapp.cancel);
router.post('/wa-campaigns/:id/retry-failed', verifyToken, whatsapp.retryFailed);

router.get('/wa-campaigns/:id/conversations', verifyToken, whatsapp.conversations);
router.post('/wa-campaigns/:id/conversations/:phone/reply', verifyToken, validate(waReplySchema), whatsapp.reply);

module.exports = router;
