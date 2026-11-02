-- ---------------------------------------------------------------------------
-- Logo and banner pictures uploaded from the panel, served publicly at
-- /api/c/img/<token>.<ext> so a campaign can show them without anyone hosting
-- them on a website first.
--
-- They outlive the campaign on purpose (campaign_id is SET NULL, not CASCADE):
-- an email that went out months ago still points at its pictures, and a
-- duplicated campaign keeps using the same links.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campaign_images (
    id           serial PRIMARY KEY,
    tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id  integer REFERENCES campaigns(id) ON DELETE SET NULL,
    token        text NOT NULL UNIQUE,
    content_type text NOT NULL,
    size_bytes   integer NOT NULL,
    content      bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    -- The three formats every inbox shows. SVG and WebP are converted by the
    -- panel before upload: Gmail shows no SVG, Outlook no WebP.
    CONSTRAINT campaign_images_type_chk CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif'))
);
