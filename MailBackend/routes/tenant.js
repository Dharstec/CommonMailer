const express = require('express');
const router = express.Router();
const tenant = require('../models/tenant');
const { verifyToken } = require('../middleware/auth');
const { validate, tenantSchema, smtpSchema } = require('../helpers/validator');

router.get('/tenants', verifyToken, tenant.getAll);
router.get('/tenants/:id', verifyToken, tenant.getOne);
router.post('/tenants', verifyToken, validate(tenantSchema), tenant.create);
router.put('/tenants/:id', verifyToken, validate(tenantSchema), tenant.update);
router.delete('/tenants/:id', verifyToken, tenant.remove);

router.put('/tenants/:id/smtp', verifyToken, validate(smtpSchema), tenant.saveSmtp);
router.post('/tenants/:id/smtp/test', verifyToken, tenant.testSmtp);
router.post('/tenants/:id/smtp/send-test', verifyToken, tenant.sendTestMail);

module.exports = router;
