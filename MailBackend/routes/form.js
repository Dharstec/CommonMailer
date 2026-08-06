const express = require('express');
const router = express.Router();
const form = require('../models/form');
const template = require('../models/template');
const { verifyToken } = require('../middleware/auth');
const { validate, formSchema, templateSchema } = require('../helpers/validator');

router.get('/forms', verifyToken, form.getAll);
router.get('/forms/:id', verifyToken, form.getOne);
router.post('/forms', verifyToken, validate(formSchema), form.create);
router.put('/forms/:id', verifyToken, validate(formSchema), form.update);
router.delete('/forms/:id', verifyToken, form.remove);
router.post('/forms/:id/duplicate', verifyToken, form.duplicate);

router.get('/forms/:formId/templates', verifyToken, template.getByForm);
router.put('/forms/:formId/templates', verifyToken, validate(templateSchema), template.save);
router.post('/forms/:formId/templates/preview', verifyToken, template.preview);
router.post('/forms/:formId/templates/send-test', verifyToken, template.sendTest);

module.exports = router;
