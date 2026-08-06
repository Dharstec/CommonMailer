-- ---------------------------------------------------------------------------
-- CommonMailer core schema.
--
-- The whole point of this service: a contact form is DATA, not code. A new
-- customer website means new rows in tenants / forms / form_fields /
-- email_templates — never a new deploy. The backend renders validation from
-- form_fields and the mail body from email_templates at request time.
-- ---------------------------------------------------------------------------

-- Admin panel operators (you and your team). Not customers.
CREATE TABLE IF NOT EXISTS admin_users (
    id            serial PRIMARY KEY,
    name          text NOT NULL,
    email         text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'admin',
    token         jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_active     boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per customer / website you host a form for.
CREATE TABLE IF NOT EXISTS tenants (
    id            serial PRIMARY KEY,
    name          text NOT NULL,
    slug          text NOT NULL UNIQUE,
    website_url   text,
    contact_email text,
    notes         text,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Per-customer sending account. password_enc is AES-256-GCM ciphertext produced
-- by helpers/crypto.js — the plaintext password never touches the database and
-- is never returned by any API.
CREATE TABLE IF NOT EXISTS tenant_smtp (
    id           serial PRIMARY KEY,
    tenant_id    integer NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
    host         text NOT NULL,
    port         integer NOT NULL DEFAULT 587,
    secure       boolean NOT NULL DEFAULT false,   -- true = implicit TLS (465)
    username     text NOT NULL,
    password_enc text NOT NULL,
    from_name    text NOT NULL,
    from_email   text NOT NULL,
    reply_to     text,
    is_active    boolean NOT NULL DEFAULT true,
    verified_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A single form on a customer site. form_key is what the embed snippet carries,
-- so it is public — treat it as an identifier, never as a secret.
CREATE TABLE IF NOT EXISTS forms (
    id                 serial PRIMARY KEY,
    tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_key           text NOT NULL UNIQUE,
    name               text NOT NULL,
    description        text,

    -- where the notification goes
    recipients         text[] NOT NULL DEFAULT '{}',
    cc                 text[] NOT NULL DEFAULT '{}',
    bcc                text[] NOT NULL DEFAULT '{}',

    -- only these origins may read the schema or submit. Empty = block all
    -- browser traffic (server-to-server calls with no Origin still allowed).
    allowed_origins    text[] NOT NULL DEFAULT '{}',

    -- rendering
    title              text,
    intro_text         text,
    submit_button_text text NOT NULL DEFAULT 'Send Message',
    success_message    text NOT NULL DEFAULT 'Thank you. Your message has been sent.',
    layout_columns     smallint NOT NULL DEFAULT 1,

    -- anti-spam
    honeypot_field     text NOT NULL DEFAULT 'website_url_hp',
    min_submit_seconds integer NOT NULL DEFAULT 3,
    max_per_hour_per_ip integer NOT NULL DEFAULT 5,
    recaptcha_enabled  boolean NOT NULL DEFAULT false,
    recaptcha_site_key text,
    recaptcha_secret_enc text,
    recaptcha_min_score numeric(3,2) NOT NULL DEFAULT 0.50,

    -- auto reply to the visitor
    autoreply_enabled  boolean NOT NULL DEFAULT false,
    autoreply_to_field text,          -- field_key holding the visitor's email

    store_submissions  boolean NOT NULL DEFAULT true,
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT forms_layout_columns_chk CHECK (layout_columns BETWEEN 1 AND 3)
);

CREATE INDEX IF NOT EXISTS idx_forms_tenant ON forms(tenant_id);

-- The dynamic part: each row becomes one input on the customer's page AND one
-- rule in the server-side Joi schema. Add a row, the field appears and is
-- validated. No deploy.
CREATE TABLE IF NOT EXISTS form_fields (
    id              serial PRIMARY KEY,
    form_id         integer NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    field_key       text NOT NULL,
    label           text NOT NULL,
    field_type      text NOT NULL DEFAULT 'text',
    placeholder     text,
    help_text       text,
    default_value   text,

    is_required     boolean NOT NULL DEFAULT false,
    min_length      integer,
    max_length      integer,
    min_value       numeric,
    max_value       numeric,
    pattern         text,             -- RE2-safe regex, validated on save
    pattern_message text,

    options         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{label,value}] for select/radio/checkbox_group
    textarea_rows   smallint NOT NULL DEFAULT 4,
    col_span        smallint NOT NULL DEFAULT 1,
    sort_order      integer NOT NULL DEFAULT 0,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT form_fields_key_uniq UNIQUE (form_id, field_key),
    CONSTRAINT form_fields_type_chk CHECK (field_type IN (
        'text','email','tel','number','textarea','select','radio',
        'checkbox','checkbox_group','date','url','hidden'
    ))
);

CREATE INDEX IF NOT EXISTS idx_form_fields_form ON form_fields(form_id, sort_order);

-- Mail bodies with {{field_key}} placeholders. Two per form at most:
-- 'admin' (to the customer's inbox) and 'autoreply' (to the visitor).
CREATE TABLE IF NOT EXISTS email_templates (
    id            serial PRIMARY KEY,
    form_id       integer NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    template_type text NOT NULL,
    subject       text NOT NULL,
    html_body     text NOT NULL,
    text_body     text,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT email_templates_uniq UNIQUE (form_id, template_type),
    CONSTRAINT email_templates_type_chk CHECK (template_type IN ('admin','autoreply'))
);

-- Every submission, kept for the admin panel log and for per-IP rate limiting.
CREATE TABLE IF NOT EXISTS submissions (
    id           bigserial PRIMARY KEY,
    form_id      integer NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    data         jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip           text,
    user_agent   text,
    referer      text,
    origin       text,
    mail_status  text NOT NULL DEFAULT 'pending',
    mail_error   text,
    message_id   text,
    spam_reason  text,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT submissions_status_chk CHECK (mail_status IN ('pending','sent','failed','spam'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_form_created ON submissions(form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_ip_created ON submissions(ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_tenant ON submissions(tenant_id, created_at DESC);
