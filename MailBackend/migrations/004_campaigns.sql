-- ---------------------------------------------------------------------------
-- Campaigns: one message, written once, sent to a whole list.
--
-- Kept apart from forms on purpose. A form is inbound (a visitor writes to the
-- customer); a campaign is outbound (the customer writes to a list). The only
-- thing they share is the sending account in tenant_smtp, so a campaign leaves
-- from the customer's own mailbox and keeps SPF/DKIM intact exactly the way a
-- form notification does.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campaigns (
    id               serial PRIMARY KEY,
    tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name             text NOT NULL,
    status           text NOT NULL DEFAULT 'draft',

    -- envelope. Blank from_name / from_email fall back to the sending account.
    from_name        text,
    from_email       text,
    reply_to         text,
    subject          text NOT NULL DEFAULT '',
    preheader        text,

    -- body: a design key plus the structured fields it renders, or raw HTML
    -- when design = 'custom'
    design           text NOT NULL DEFAULT 'executive',
    content          jsonb NOT NULL DEFAULT '{}'::jsonb,
    custom_html      text,

    -- what the last recipient upload contained, for the panel
    columns          text[] NOT NULL DEFAULT '{}',
    import_summary   jsonb,

    -- delivery
    track_opens      boolean NOT NULL DEFAULT true,
    rate_per_minute  integer NOT NULL DEFAULT 20,
    daily_limit      integer NOT NULL DEFAULT 0,      -- 0 = no limit
    scheduled_at     timestamptz,
    next_send_at     timestamptz,                     -- throttle state, so it survives a restart
    retry_count      integer NOT NULL DEFAULT 0,      -- consecutive temporary SMTP failures
    status_reason    text,                            -- why it paused, or what it is waiting for

    started_at       timestamptz,
    completed_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaigns_status_chk CHECK (status IN ('draft','scheduled','sending','paused','completed','cancelled')),
    CONSTRAINT campaigns_rate_chk CHECK (rate_per_minute BETWEEN 1 AND 60),
    CONSTRAINT campaigns_daily_limit_chk CHECK (daily_limit >= 0)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_due ON campaigns(status, next_send_at);

-- One row per address on the list. `token` is the recipient's own key for the
-- unsubscribe link and the open pixel. It is random rather than the row id,
-- because an id would let anyone unsubscribe a whole list by counting.
CREATE TABLE IF NOT EXISTS campaign_recipients (
    id              bigserial PRIMARY KEY,
    campaign_id     integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    email           text NOT NULL,
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the CSV row, for {{merge}} fields
    token           text NOT NULL UNIQUE,
    status          text NOT NULL DEFAULT 'pending',
    error           text,
    message_id      text,
    attempted_at    timestamptz,
    sent_at         timestamptz,
    opened_at       timestamptz,
    open_count      integer NOT NULL DEFAULT 0,
    unsubscribed_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_recipients_status_chk CHECK (status IN ('pending','sending','sent','failed','skipped')),
    CONSTRAINT campaign_recipients_email_uniq UNIQUE (campaign_id, email)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_queue ON campaign_recipients(campaign_id, status, id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_attempted ON campaign_recipients(campaign_id, attempted_at DESC);

-- Files sent with every message of a campaign. Stored in the database rather
-- than on disk so the nightly pg_dump already backs them up.
CREATE TABLE IF NOT EXISTS campaign_attachments (
    id           serial PRIMARY KEY,
    campaign_id  integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    filename     text NOT NULL,
    content_type text,
    size_bytes   integer NOT NULL,
    content      bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_attachments_campaign ON campaign_attachments(campaign_id);

-- The do-not-email list, per customer. An unsubscribe outlives the campaign it
-- came from: the next upload for the same customer drops these addresses, and
-- the sender checks the list again right before every message.
CREATE TABLE IF NOT EXISTS campaign_unsubscribes (
    id          serial PRIMARY KEY,
    tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       text NOT NULL,
    source      text NOT NULL DEFAULT 'link',   -- link | one_click | manual
    campaign_id integer REFERENCES campaigns(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_unsubscribes_uniq UNIQUE (tenant_id, email),
    CONSTRAINT campaign_unsubscribes_source_chk CHECK (source IN ('link','one_click','manual'))
);
