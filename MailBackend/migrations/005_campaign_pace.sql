-- ---------------------------------------------------------------------------
-- Campaign pace belongs to the mailbox, not to the campaign.
--
-- A new domain that suddenly sends a lot is exactly what spam filters look
-- for, and a mailbox has one reputation however many campaigns it runs. So the
-- limits — at least CAMPAIGN_GAP_MINUTES between two emails, at most
-- CAMPAIGN_DAILY_LIMIT in any 24 hours — are counted per customer (one
-- customer = one SMTP mailbox) across all of its campaigns, and are set on the
-- server rather than per campaign in the panel. See helpers/campaignPace.js.
-- ---------------------------------------------------------------------------

-- When each mailbox may send its next campaign email. The sender claims it
-- before a message and moves it forward afterwards.
CREATE TABLE IF NOT EXISTS campaign_pace (
    tenant_id    integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    next_send_at timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Every campaign email handed to the mail server, whatever it answered.
-- Append-only: retrying failed messages or deleting a campaign must not hand
-- the mailbox back any of its day.
CREATE TABLE IF NOT EXISTS campaign_send_log (
    id           bigserial PRIMARY KEY,
    tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id  integer REFERENCES campaigns(id) ON DELETE SET NULL,
    attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_send_log_tenant ON campaign_send_log(tenant_id, attempted_at DESC);

-- What went out in the day before this upgrade counts towards the first day
-- on the new limits, and the first email waits out the gap after the last one.
INSERT INTO campaign_send_log (tenant_id, campaign_id, attempted_at)
SELECT c.tenant_id, r.campaign_id, r.attempted_at
  FROM campaign_recipients r
  JOIN campaigns c ON c.id = r.campaign_id
 WHERE r.attempted_at > now() - interval '24 hours'
   AND NOT EXISTS (SELECT 1 FROM campaign_send_log);

INSERT INTO campaign_pace (tenant_id, next_send_at)
SELECT c.tenant_id, max(r.attempted_at) + interval '5 minutes'
  FROM campaign_recipients r
  JOIN campaigns c ON c.id = r.campaign_id
 WHERE r.attempted_at IS NOT NULL
 GROUP BY c.tenant_id
ON CONFLICT (tenant_id) DO NOTHING;

-- Replaced by the mailbox's pace.
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_rate_chk;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_daily_limit_chk;
ALTER TABLE campaigns DROP COLUMN IF EXISTS rate_per_minute;
ALTER TABLE campaigns DROP COLUMN IF EXISTS daily_limit;
