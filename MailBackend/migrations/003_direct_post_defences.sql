-- Closes the hole that let a bot POST straight at /api/form/:formKey and bypass
-- every browser-side trap: no Origin header, no honeypot field, no _ts token.
--
-- Three new per-form settings, all defaulted so an upgrade changes no existing
-- form's behaviour on its own.

-- 1. Reject a submission that carries no Origin header at all.
--    Browsers always send Origin on a cross-origin POST (and on same-origin
--    POSTs too, per the Fetch spec), so "absent" means "not a browser".
ALTER TABLE forms ADD COLUMN IF NOT EXISTS require_origin boolean NOT NULL DEFAULT true;

-- Existing forms only get it switched on where an allowlist is already filled
-- in. A form with an empty allowlist currently accepts *nothing but* no-Origin
-- traffic, so flipping this on for those would take the form offline.
UPDATE forms
   SET require_origin = (array_length(allowed_origins, 1) IS NOT NULL)
 WHERE require_origin IS DISTINCT FROM (array_length(allowed_origins, 1) IS NOT NULL);

-- 2. Suppress an identical payload replayed within N minutes. Spam runs retry;
--    a person who double-clicks Send hits the same path.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS duplicate_window_minutes integer NOT NULL DEFAULT 10;

-- 3. Opt-in heuristic that drops payloads whose free text is random characters.
--    Off by default: it is the only check here that can misjudge a real person.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS content_filter_enabled boolean NOT NULL DEFAULT false;

-- ADD CONSTRAINT has no IF NOT EXISTS, so guard it to keep the file re-runnable
-- against a database that was already patched by hand.
DO $$
BEGIN
    ALTER TABLE forms
        ADD CONSTRAINT forms_duplicate_window_chk
        CHECK (duplicate_window_minutes BETWEEN 0 AND 1440);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Fingerprint of the submitted values, used only by the duplicate check.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS payload_hash text;

CREATE INDEX IF NOT EXISTS idx_submissions_dupe
    ON submissions(form_id, payload_hash, created_at DESC);
