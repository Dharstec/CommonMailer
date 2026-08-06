/**
 * Turns form_fields rows into a Joi schema at request time.
 *
 * This is what removes backend work per customer: the validation rules are read
 * from the database on every submit, so adding a field in the admin panel
 * immediately makes that field validated server-side. The browser is never
 * trusted — the embed widget's HTML5 validation is convenience only, this is
 * the real gate.
 *
 * `.unknown(false)` is deliberate: a payload carrying keys that are not defined
 * fields is rejected outright rather than quietly passed through into the mail
 * template.
 */
const Joi = require('joi');

// Rejects anything that looks like markup. Contact forms are plain text; a
// visitor has no legitimate reason to send tags, and this keeps injected markup
// out of the notification mail before escaping even comes into play.
const noHtmlValidator = (value, helpers) => {
    if (typeof value === 'string' && /<[^>]*>/.test(value)) {
        return helpers.error('string.noHtmlTags');
    }
    return value;
};

const NO_HTML_MESSAGE = { 'string.noHtmlTags': '{{#label}} must not contain HTML tags' };

// Cap on any free-text field that does not declare its own max_length, so a
// missing setting can never mean "unbounded".
const DEFAULT_MAX_TEXT = 2000;
const DEFAULT_MAX_TEXTAREA = 5000;

/**
 * User-supplied regexes are run against user-supplied input, which is a ReDoS
 * risk. Reject patterns with nested quantifiers before they ever reach the
 * matcher, and keep them short.
 */
function safePattern(pattern) {
    if (!pattern) return null;
    if (pattern.length > 200) return null;
    // (a+)+ , (a*)* , (a+)* ... nested quantifier = catastrophic backtracking
    if (/\([^)]*[+*][^)]*\)\s*[+*]/.test(pattern)) return null;
    try {
        return new RegExp(pattern);
    } catch (err) {
        return null;
    }
}

function allowedValues(field) {
    return (Array.isArray(field.options) ? field.options : [])
        .map((o) => (o && o.value !== undefined ? String(o.value) : null))
        .filter((v) => v !== null);
}

function buildFieldRule(field) {
    const label = field.label || field.field_key;
    let rule;

    switch (field.field_type) {
        case 'email':
            rule = Joi.string().trim().max(field.max_length || 254)
                .email({ minDomainSegments: 2, tlds: { allow: false } })
                .messages({ 'string.email': `${label} must be a valid email address` });
            break;

        case 'number': {
            rule = Joi.number();
            if (field.min_value !== null && field.min_value !== undefined) rule = rule.min(Number(field.min_value));
            if (field.max_value !== null && field.max_value !== undefined) rule = rule.max(Number(field.max_value));
            break;
        }

        case 'tel':
            // Digits, spaces and the usual separators. Length bounded so a phone
            // field can never carry a paragraph.
            rule = Joi.string().trim()
                .pattern(/^[0-9+\-\s()]{6,20}$/)
                .messages({ 'string.pattern.base': `${label} must be a valid phone number` });
            break;

        case 'url':
            rule = Joi.string().trim().max(500).uri({ scheme: ['http', 'https'] })
                .messages({ 'string.uri': `${label} must be a valid http(s) URL` });
            break;

        case 'date':
            rule = Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/)
                .messages({ 'string.pattern.base': `${label} must be a valid date (YYYY-MM-DD)` });
            break;

        case 'checkbox':
            // Single consent-style box. Required means "must be ticked".
            rule = Joi.boolean().truthy('true', 'on', '1', 1).falsy('false', 'off', '0', 0);
            if (field.is_required) {
                rule = rule.valid(true).messages({ 'any.only': `${label} must be accepted` });
            }
            break;

        case 'select':
        case 'radio': {
            const values = allowedValues(field);
            rule = values.length
                ? Joi.string().trim().valid(...values)
                    .messages({ 'any.only': `${label} must be one of the listed options` })
                : Joi.string().trim().max(DEFAULT_MAX_TEXT).custom(noHtmlValidator).messages(NO_HTML_MESSAGE);
            break;
        }

        case 'checkbox_group': {
            const values = allowedValues(field);
            const item = values.length ? Joi.string().valid(...values) : Joi.string().max(200).custom(noHtmlValidator);
            rule = Joi.array().items(item).max(50)
                .messages({ 'array.base': `${label} must be a list of choices` });
            if (field.is_required) rule = rule.min(1).messages({ 'array.min': `${label} is required` });
            break;
        }

        case 'textarea':
            rule = Joi.string().trim()
                .max(field.max_length || DEFAULT_MAX_TEXTAREA)
                .custom(noHtmlValidator).messages(NO_HTML_MESSAGE);
            if (field.min_length) rule = rule.min(field.min_length);
            break;

        case 'hidden':
        case 'text':
        default: {
            rule = Joi.string().trim()
                .max(field.max_length || DEFAULT_MAX_TEXT)
                .custom(noHtmlValidator).messages(NO_HTML_MESSAGE);
            if (field.min_length) rule = rule.min(field.min_length);
            const re = safePattern(field.pattern);
            if (re) {
                rule = rule.pattern(re).messages({
                    'string.pattern.base': field.pattern_message || `${label} is not in the expected format`
                });
            }
            break;
        }
    }

    if (field.is_required) {
        rule = rule.required().messages({
            'any.required': `${label} is required`,
            'string.empty': `${label} is required`
        });
    } else {
        // Optional fields may arrive as '' from a browser; treat that as absent.
        rule = rule.allow('', null).optional();
    }

    return rule.label(label);
}

/**
 * @param {Array} fields  active form_fields rows, any order
 * @param {Object} form   the parent form row (supplies the honeypot field name)
 * @returns {Joi.ObjectSchema}
 */
function buildSchema(fields, form) {
    const shape = {};

    for (const field of fields) {
        if (field.is_active === false) continue;
        shape[field.field_key] = buildFieldRule(field);
    }

    // The honeypot is accepted (so a bot filling it reaches our spam branch and
    // gets a fake success) but must be empty for a real submission.
    if (form && form.honeypot_field) {
        shape[form.honeypot_field] = Joi.string().allow('', null).optional();
    }

    // Client-side timing token and captcha response ride along with the payload.
    shape._ts = Joi.string().allow('', null).optional();
    shape._captcha = Joi.string().allow('', null).optional();

    return Joi.object(shape).unknown(false);
}

module.exports = { buildSchema, safePattern };
