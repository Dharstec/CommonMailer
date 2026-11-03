/**
 * Pictures uploaded from the panel — email logos and banners, WhatsApp
 * headers — stored in campaign_images and served at /api/c/img/<token>.<ext>
 * (models/campaignPublic.js), so nobody has to host them on a website first.
 *
 * Recognised by their first bytes rather than by what the browser claims, and
 * only what every inbox and WhatsApp shows: the panel turns SVG and WebP into
 * PNG or JPG before it uploads.
 */
const crypto = require('crypto');
const POSTGRESQLService = require('./POSTGRES');
const { baseUrl } = require('./links');

const IMAGE_TYPES = [
    { type: 'image/png', ext: 'png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { type: 'image/jpeg', ext: 'jpg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
    { type: 'image/gif', ext: 'gif', magic: Buffer.from('GIF8') }
];

const OWN_IMAGE = /\/api\/c\/img\/([A-Za-z0-9_-]{16,64})\.(png|jpg|gif)$/;

function detect(buffer) {
    return IMAGE_TYPES.find((t) => buffer.subarray(0, t.magic.length).equals(t.magic)) || null;
}

/** Stores a picture; null when the bytes are not a PNG, JPG or GIF. */
async function save({ tenantId, campaignId = null, buffer }) {
    const kind = detect(buffer);
    if (!kind) return null;
    const token = crypto.randomBytes(18).toString('base64url');
    await POSTGRESQLService.PostgresAny(
        `INSERT INTO campaign_images (tenant_id, campaign_id, token, content_type, size_bytes, content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, campaignId, token, kind.type, buffer.length, buffer]
    );
    return { url: `${baseUrl()}/api/c/img/${token}.${kind.ext}`, content_type: kind.type, size_bytes: buffer.length };
}

/** The stored bytes behind one of our own picture links, or null for any other link. */
async function loadOwn(url) {
    const match = OWN_IMAGE.exec(String(url || '').split('?')[0]);
    if (!match) return null;
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT content_type, content FROM campaign_images WHERE token = $1`, [match[1]]
    );
    return rows[0] || null;
}

module.exports = { detect, save, loadOwn };
