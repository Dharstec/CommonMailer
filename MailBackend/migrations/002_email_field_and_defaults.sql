-- ---------------------------------------------------------------------------
-- Settle the schema on the API-only flow.
--
-- 1. The timing trap now needs the customer's HTML to send a `_ts` value. That
--    is opt-in, so the default drops to 0 (off) rather than silently doing
--    nothing on every form.
-- 2. Every form must carry an `email` field. Backfill any form that predates
--    that rule so existing rows satisfy it too.
-- ---------------------------------------------------------------------------

ALTER TABLE forms ALTER COLUMN min_submit_seconds SET DEFAULT 0;

UPDATE forms SET min_submit_seconds = 0 WHERE min_submit_seconds = 3;

-- Add the required email field to any form that lacks one, at the top.
INSERT INTO form_fields (form_id, field_key, label, field_type, is_required, sort_order, is_active)
SELECT f.id, 'email', 'Email Address', 'email', true, -1, true
  FROM forms f
 WHERE NOT EXISTS (
     SELECT 1 FROM form_fields ff WHERE ff.form_id = f.id AND ff.field_key = 'email'
 );

-- An existing `email` field that was optional or the wrong type would now fail
-- validation on the next save, so bring it in line.
UPDATE form_fields
   SET field_type = 'email', is_required = true, is_active = true
 WHERE field_key = 'email'
   AND (field_type <> 'email' OR is_required = false OR is_active = false);

-- With an email field guaranteed, auto-reply always has somewhere to send.
UPDATE forms SET autoreply_to_field = 'email'
 WHERE autoreply_enabled = true AND (autoreply_to_field IS NULL OR autoreply_to_field = '');
