-- ---------------------------------------------------------------------------
-- WhatsApp campaigns, through Meta's official WhatsApp Business Platform
-- (Cloud API). Business-started messages must use a template Meta approved,
-- and every send, delivery, read and reply comes back by webhook.
--
-- Kept apart from the email tables: the queue, the pace and the do-not-contact
-- list of one channel say nothing about the other.
-- ---------------------------------------------------------------------------

-- One WhatsApp number per customer. Secrets are stored encrypted, like SMTP passwords.
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id               serial PRIMARY KEY,
    tenant_id        integer NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
    phone_number_id  text NOT NULL,
    waba_id          text NOT NULL,
    app_id           text,                          -- only needed to create templates with a picture
    access_token_enc text NOT NULL,
    app_secret_enc   text NOT NULL,                 -- proves a webhook call really came from Meta
    verify_token     text NOT NULL,                 -- Meta echoes it once, when the webhook is set up
    default_country  text NOT NULL DEFAULT '91',    -- for numbers written without a country code
    notify_emails    text,                          -- replies are emailed here as well

    -- what Meta last said about the number
    display_phone    text,
    verified_name    text,
    quality_rating   text,
    messaging_limit  text,
    checked_at       timestamptz,
    webhook_seen_at  timestamptz,

    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One number, one customer: Meta's webhook names the number, and that has to point at exactly one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_accounts_phone ON whatsapp_accounts(phone_number_id);

CREATE TABLE IF NOT EXISTS wa_campaigns (
    id                  serial PRIMARY KEY,
    tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                text NOT NULL,
    status              text NOT NULL DEFAULT 'draft',

    -- the approved template, as Meta returned it when it was chosen
    template_name       text,
    template_language   text,
    template_category   text,
    template_components jsonb,
    template_format     text,                       -- POSITIONAL ({{1}}) or NAMED ({{first_name}})

    -- what fills each template variable: {"header": "...", "body": {"1": "{{first_name|Sir}}"}, "buttons": {"0": "..."}}
    variables           jsonb NOT NULL DEFAULT '{}'::jsonb,
    header_media_url    text,

    columns             text[] NOT NULL DEFAULT '{}',
    import_summary      jsonb,

    scheduled_at        timestamptz,
    next_send_at        timestamptz,
    retry_count         integer NOT NULL DEFAULT 0,
    status_reason       text,
    started_at          timestamptz,
    completed_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT wa_campaigns_status_chk CHECK (status IN ('draft','scheduled','sending','paused','completed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_wa_campaigns_tenant ON wa_campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wa_campaigns_due ON wa_campaigns(status, next_send_at);

-- One row per number on the list. delivered/read/replied arrive by webhook.
CREATE TABLE IF NOT EXISTS wa_recipients (
    id            bigserial PRIMARY KEY,
    campaign_id   integer NOT NULL REFERENCES wa_campaigns(id) ON DELETE CASCADE,
    phone         text NOT NULL,                    -- digits with country code: 919840624198
    data          jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        text NOT NULL DEFAULT 'pending',
    wa_message_id text,
    error         text,
    attempted_at  timestamptz,
    sent_at       timestamptz,
    delivered_at  timestamptz,
    read_at       timestamptz,
    replied_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT wa_recipients_status_chk CHECK (status IN ('pending','sending','sent','delivered','read','failed','skipped')),
    CONSTRAINT wa_recipients_phone_uniq UNIQUE (campaign_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_wa_recipients_queue ON wa_recipients(campaign_id, status, id);
CREATE INDEX IF NOT EXISTS idx_wa_recipients_message ON wa_recipients(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_wa_recipients_phone ON wa_recipients(phone);

-- The conversation after a campaign: replies in, and the answers sent from the panel.
CREATE TABLE IF NOT EXISTS wa_messages (
    id            bigserial PRIMARY KEY,
    tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id   integer REFERENCES wa_campaigns(id) ON DELETE SET NULL,
    phone         text NOT NULL,
    direction     text NOT NULL,
    body          text,
    wa_message_id text UNIQUE,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT wa_messages_direction_chk CHECK (direction IN ('in','out'))
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation ON wa_messages(tenant_id, phone, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_campaign ON wa_messages(campaign_id, created_at);

-- The do-not-message list, per customer: "STOP" replies, the opt-out button, or added by hand.
CREATE TABLE IF NOT EXISTS wa_optouts (
    id          serial PRIMARY KEY,
    tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone       text NOT NULL,
    source      text NOT NULL DEFAULT 'reply',
    campaign_id integer REFERENCES wa_campaigns(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT wa_optouts_uniq UNIQUE (tenant_id, phone),
    CONSTRAINT wa_optouts_source_chk CHECK (source IN ('reply','button','manual'))
);

-- The number's pace, as campaign_pace / campaign_send_log are the mailbox's.
CREATE TABLE IF NOT EXISTS wa_pace (
    tenant_id    integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    next_send_at timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_send_log (
    id           bigserial PRIMARY KEY,
    tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id  integer REFERENCES wa_campaigns(id) ON DELETE SET NULL,
    attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_send_log_tenant ON wa_send_log(tenant_id, attempted_at DESC);
