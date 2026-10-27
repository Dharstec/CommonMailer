/**
 * Joi schemas for the ADMIN api. (The public submit endpoint builds its schema
 * at runtime from the database instead — see helpers/dynamicValidator.js.)
 */
const Joi = require('joi');
const { DESIGN_KEYS } = require('./campaignRender');

const noHtmlValidator = (value, helpers) => {
    if (typeof value === 'string' && /<[^>]*>/.test(value)) {
        return helpers.error('string.noHtmlTags');
    }
    return value;
};
const noHtml = () => Joi.string().custom(noHtmlValidator)
    .messages({ 'string.noHtmlTags': '{{#label}} must not contain HTML tags' });

/**
 * Google shows an App Password as four groups of four letters — "abcd efgh ijkl
 * mnop" — and mail clients silently strip the spaces before sending it. Nodemailer
 * does not, so a pasted-as-shown password is transmitted with spaces and Gmail
 * answers 535 "Username and Password not accepted", which reads as a wrong
 * password and sends people hunting for the wrong problem.
 *
 * Only this exact shape is normalised. Any other password keeps its spaces,
 * because a real passphrase is allowed to contain them.
 */
const GOOGLE_APP_PASSWORD = /^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$/i;

const normaliseAppPassword = (value) => {
    if (typeof value === 'string' && GOOGLE_APP_PASSWORD.test(value.trim())) {
        return value.trim().replace(/\s+/g, '');
    }
    return value;
};

// Identifiers that end up in URLs and template placeholders. Restricting the
// charset keeps them safe to interpolate anywhere without further escaping.
const slug = Joi.string().trim().lowercase().min(2).max(60).pattern(/^[a-z0-9][a-z0-9-]*$/)
    .messages({ 'string.pattern.base': '{{#label}} may contain only lowercase letters, numbers and hyphens' });

const fieldKey = Joi.string().trim().min(1).max(50).pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .messages({ 'string.pattern.base': '{{#label}} may contain only letters, numbers and underscore, and must not start with a number' });

const emailList = Joi.array().items(Joi.string().trim().email({ tlds: { allow: false } })).max(20);

// Full origins only ("https://site.com"), optionally a wildcard subdomain.
// A bare hostname would be ambiguous about scheme and never match a real
// Origin header.
const originList = Joi.array().items(
    Joi.string().trim().max(200).pattern(/^(\*|https?:\/\/(\*\.)?[a-zA-Z0-9.-]+(:\d+)?)$/)
        .messages({ 'string.pattern.base': 'Each origin must look like https://example.com, https://*.example.com or *' })
).max(20);

const tenantSchema = Joi.object({
    name: noHtml().trim().min(2).max(120).required().label('Customer name'),
    slug: slug.required().label('Slug'),
    website_url: Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(200).allow('', null).label('Website URL'),
    contact_email: Joi.string().trim().email({ tlds: { allow: false } }).allow('', null).label('Contact email'),
    notes: noHtml().trim().max(1000).allow('', null).label('Notes'),
    is_active: Joi.boolean().default(true)
});

const smtpSchema = Joi.object({
    host: Joi.string().trim().hostname().max(200).required().label('SMTP host'),
    port: Joi.number().integer().min(1).max(65535).default(587).label('SMTP port'),
    secure: Joi.boolean().default(false),
    username: Joi.string().trim().max(200).required().label('SMTP username'),
    // Optional on update: blank means "keep the stored password".
    password: Joi.string().trim().max(300).custom(normaliseAppPassword)
        .allow('', null).label('SMTP password'),
    from_name: noHtml().trim().max(100).required().label('From name'),
    from_email: Joi.string().trim().email({ tlds: { allow: false } }).required().label('From email'),
    reply_to: Joi.string().trim().email({ tlds: { allow: false } }).allow('', null).label('Reply-To'),
    is_active: Joi.boolean().default(true)
});

const fieldSchema = Joi.object({
    id: Joi.number().integer().allow(null),
    field_key: fieldKey.required().label('Field key'),
    label: noHtml().trim().min(1).max(150).required().label('Label'),
    field_type: Joi.string().valid(
        'text', 'email', 'tel', 'number', 'textarea', 'select', 'radio',
        'checkbox', 'checkbox_group', 'date', 'url', 'hidden'
    ).default('text').label('Field type'),
    placeholder: noHtml().trim().max(200).allow('', null),
    help_text: noHtml().trim().max(300).allow('', null),
    default_value: noHtml().trim().max(300).allow('', null),
    is_required: Joi.boolean().default(false),
    min_length: Joi.number().integer().min(0).max(10000).allow(null),
    max_length: Joi.number().integer().min(1).max(10000).allow(null),
    min_value: Joi.number().allow(null),
    max_value: Joi.number().allow(null),
    pattern: Joi.string().trim().max(200).allow('', null),
    pattern_message: noHtml().trim().max(200).allow('', null),
    options: Joi.array().items(Joi.object({
        label: noHtml().trim().max(150).required(),
        value: noHtml().trim().max(150).required()
    })).max(100).default([]),
    textarea_rows: Joi.number().integer().min(2).max(20).default(4),
    col_span: Joi.number().integer().min(1).max(3).default(1),
    sort_order: Joi.number().integer().min(0).default(0),
    is_active: Joi.boolean().default(true)
});

const formSchema = Joi.object({
    tenant_id: Joi.number().integer().required().label('Customer'),
    form_key: slug.max(80).required().label('Form key'),
    name: noHtml().trim().min(2).max(150).required().label('Form name'),
    description: noHtml().trim().max(500).allow('', null),

    recipients: emailList.min(1).required().label('Recipients')
        .messages({ 'array.min': 'At least one recipient email is required' }),
    cc: emailList.default([]),
    bcc: emailList.default([]),
    allowed_origins: originList.default([]).label('Allowed website origins'),

    title: noHtml().trim().max(150).allow('', null),
    intro_text: noHtml().trim().max(500).allow('', null),
    submit_button_text: noHtml().trim().max(60).default('Send Message'),
    success_message: noHtml().trim().max(300).default('Thank you. Your message has been sent.'),
    layout_columns: Joi.number().integer().min(1).max(3).default(1),

    honeypot_field: fieldKey.default('website_url_hp').label('Honeypot field name'),
    min_submit_seconds: Joi.number().integer().min(0).max(120).default(0),
    max_per_hour_per_ip: Joi.number().integer().min(0).max(1000).default(5),
    require_origin: Joi.boolean().default(true).label('Require a browser Origin'),
    duplicate_window_minutes: Joi.number().integer().min(0).max(1440).default(10)
        .label('Duplicate suppression window'),
    content_filter_enabled: Joi.boolean().default(false).label('Random-text filter'),
    recaptcha_enabled: Joi.boolean().default(false),
    recaptcha_site_key: Joi.string().trim().max(200).allow('', null),
    recaptcha_secret: Joi.string().trim().max(300).allow('', null),
    recaptcha_min_score: Joi.number().min(0).max(1).default(0.5),

    autoreply_enabled: Joi.boolean().default(false),
    autoreply_to_field: fieldKey.allow('', null),

    store_submissions: Joi.boolean().default(true),
    is_active: Joi.boolean().default(true),

    fields: Joi.array().items(fieldSchema).min(1).max(60).required().label('Fields')
        .messages({ 'array.min': 'Add at least one field to the form' })
})
    // A captcha that is switched on but has no keys would silently reject every
    // visitor, so the combination is rejected at save time instead. `.required()`
    // on the subject matters: without it an absent recaptcha_enabled also
    // matches, and every form would demand a site key.
    .when(Joi.object({ recaptcha_enabled: Joi.valid(true).required() }).unknown(), {
        then: Joi.object({ recaptcha_site_key: Joi.string().trim().min(10).required() })
    });

const templateSchema = Joi.object({
    template_type: Joi.string().valid('admin', 'autoreply').required(),
    subject: Joi.string().trim().min(1).max(200).required().label('Subject'),
    // html_body intentionally allows markup — you author it, and every value
    // substituted into it is escaped by helpers/template.js.
    html_body: Joi.string().max(50000).required().label('HTML body'),
    text_body: Joi.string().max(20000).allow('', null),
    is_active: Joi.boolean().default(true)
});

const hexColor = Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/)
    .messages({ 'string.pattern.base': '{{#label}} must be a colour like #4f46e5' });

const imageUrl = Joi.string().trim().max(1000).uri({ scheme: ['http', 'https'] });

/**
 * A button link may carry {{merge}} fields (…?ref={{email}}), which are not
 * valid URL characters until they are filled in — so they are swapped for a
 * placeholder before the URL check. A link that is one field on its own, such
 * as a per-company {{website}} column, can only be checked when it is sent.
 */
const linkWithMerge = Joi.string().trim().max(1000).custom((value, helpers) => {
    if (/^\{\{[^}]+\}\}$/.test(value)) return value;
    const probe = value.replace(/\{\{[^}]*\}\}/g, 'x');
    const { error } = Joi.string().uri({ scheme: ['http', 'https', 'mailto', 'tel'] }).validate(probe);
    return error ? helpers.error('string.uri') : value;
}).messages({ 'string.uri': '{{#label}} must start with https://, mailto: or tel:' });

const campaignContentSchema = Joi.object({
    brand_color: hexColor.allow('', null).label('Brand colour'),
    logo_url: imageUrl.allow('', null).label('Logo URL'),
    logo_width: Joi.number().integer().min(40).max(300).allow(null).label('Logo width'),
    hero_image_url: imageUrl.allow('', null).label('Banner image URL'),
    headline: Joi.string().trim().max(200).allow('', null).label('Headline'),
    // Free text on purpose: it is escaped when rendered, and the light
    // formatting (**bold**, - lists) is applied to the escaped text.
    body: Joi.string().max(20000).allow('', null).label('Message'),
    cta_text: Joi.string().trim().max(60).allow('', null).label('Button text'),
    cta_url: linkWithMerge.allow('', null).label('Button link'),
    signature: Joi.string().max(1000).allow('', null).label('Signature'),
    footer_text: Joi.string().max(1000).allow('', null).label('Footer')
}).default({});

const campaignSchema = Joi.object({
    tenant_id: Joi.number().integer().required().label('Sending account'),
    name: noHtml().trim().min(2).max(150).required().label('Campaign name'),
    from_name: noHtml().trim().max(100).allow('', null).label('From name'),
    from_email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow('', null).label('From email'),
    reply_to: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow('', null).label('Reply-To'),
    // Optional while drafting; starting the campaign is what requires it.
    subject: Joi.string().trim().max(200).allow('').default('').label('Subject'),
    preheader: Joi.string().trim().max(250).allow('', null).label('Preview text'),
    design: Joi.string().valid(...DESIGN_KEYS).default('executive').label('Design'),
    content: campaignContentSchema,
    // You author it, like the form templates; recipient values merged into it
    // are escaped.
    custom_html: Joi.string().max(200000).allow('', null).label('Custom HTML'),
    track_opens: Joi.boolean().default(true),
    rate_per_minute: Joi.number().integer().min(1).max(60).default(20).label('Sending speed'),
    daily_limit: Joi.number().integer().min(0).max(100000).default(0).label('Daily limit')
});

/** Preview and test send take the unsaved editor state, so what you see is what you test. */
const campaignPreviewSchema = campaignSchema.fork(['tenant_id', 'name'], (rule) => rule.optional()).keys({
    recipient_id: Joi.number().integer().allow(null),
    to: Joi.string().trim().max(254).allow('', null)
});

const unsubscribeAddSchema = Joi.object({
    tenant_id: Joi.number().integer().required().label('Customer'),
    emails: Joi.string().max(200000).required().label('Email addresses')
});

/** Express middleware factory: validates req.body and replaces it with the cast value. */
function validate(schema) {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true, convert: true });
        if (error) {
            return res.status(400).json({
                status: 'error',
                message: 'Please correct the highlighted fields.',
                errors: error.details.map((d) => ({ field: d.path.join('.'), message: d.message }))
            });
        }
        req.body = value;
        next();
    };
}

module.exports = {
    tenantSchema, smtpSchema, formSchema, fieldSchema, templateSchema,
    campaignSchema, campaignPreviewSchema, unsubscribeAddSchema, validate
};
