-- ---------------------------------------------------------------------------
-- Replies to campaign emails, counted from the customer's own inbox over IMAP
-- — the same mailbox and password the campaign sends with. Each recipient
-- gets a "replied" time; nothing else is kept. Read-only: the inbox is never
-- changed, nothing is marked read or moved.
-- ---------------------------------------------------------------------------

ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS replied_at timestamptz;

-- How far each customer's inbox has been read, and why the last read failed.
CREATE TABLE IF NOT EXISTS campaign_inbox (
    tenant_id    integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    uid_validity text,
    last_uid     bigint NOT NULL DEFAULT 0,
    checked_at   timestamptz,
    error        text
);

-- An address that bounced goes on the do-not-email list, like an unsubscribe:
-- mailing it again only costs the domain reputation.
ALTER TABLE campaign_unsubscribes DROP CONSTRAINT IF EXISTS campaign_unsubscribes_source_chk;
ALTER TABLE campaign_unsubscribes ADD CONSTRAINT campaign_unsubscribes_source_chk
    CHECK (source IN ('link', 'one_click', 'manual', 'bounce'));
