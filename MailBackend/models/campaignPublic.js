/**
 * The two campaign URLs a recipient's mail client calls: the unsubscribe page
 * and the open pixel. There is no login — the random per-recipient token in
 * the URL is the key, and it only ever appears in that recipient's own email.
 *
 *   GET  /api/c/:token/unsubscribe   a page with a confirm button
 *   POST /api/c/:token/unsubscribe   the actual unsubscribe (the page's button,
 *                                    and RFC 8058 one-click from Gmail/Yahoo)
 *   GET  /api/c/:token/open.gif      1x1 image that records the open
 *
 * The GET deliberately changes nothing. Corporate mail scanners (Defender Safe
 * Links, Mimecast, Proofpoint) fetch every link in a message before a person
 * sees it; if GET unsubscribed, those scanners would quietly empty the list.
 * They do not POST.
 */
const POSTGRESQLService = require('../helpers/POSTGRES');
const { escapeHtml } = require('../helpers/template');
const logger = require('../helpers/logger');

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

// The smallest valid transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function findRecipient(token) {
    if (!TOKEN.test(String(token || ''))) return null;
    const rows = await POSTGRESQLService.PostgresAny(
        `SELECT r.id, r.email, r.unsubscribed_at, r.campaign_id, c.tenant_id, t.name AS tenant_name
           FROM campaign_recipients r
           JOIN campaigns c ON c.id = r.campaign_id
           JOIN tenants t ON t.id = c.tenant_id
          WHERE r.token = $1`,
        [token]
    );
    return rows[0] || null;
}

const TONES = {
    ask: { bg: '#eef2ff', fg: '#4f46e5', icon: '&#9993;' },
    done: { bg: '#ecfdf5', fg: '#059669', icon: '&#10003;' },
    info: { bg: '#f1f5f9', fg: '#475569', icon: 'i' },
    error: { bg: '#fef2f2', fg: '#dc2626', icon: '!' }
};

/**
 * The API otherwise serves JSON only, under helmet's `default-src 'none'`. This
 * page needs exactly two more things — its own inline styles, and a form that
 * posts back to itself — so the policy is replaced for this response alone.
 */
function page(res, status, { tone, heading, message, button }) {
    const t = TONES[tone];
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${heading}</title>
<style>
body{margin:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased}
.wrap{max-width:440px;margin:0 auto;padding:72px 20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:40px 32px 34px;text-align:center;box-shadow:0 12px 32px rgba(15,23,42,.06)}
.icon{width:58px;height:58px;border-radius:29px;margin:0 auto 20px;font-size:26px;font-weight:700;line-height:58px;background:${t.bg};color:${t.fg}}
h1{font-size:22px;line-height:1.3;margin:0 0 10px;letter-spacing:-.2px}
p{font-size:15px;line-height:1.6;color:#475569;margin:0}
strong{color:#0f172a;word-break:break-all}
button{margin-top:26px;width:100%;border:0;border-radius:11px;background:#0f172a;color:#fff;font:600 15px/1 inherit;font-family:inherit;padding:15px 18px;cursor:pointer}
button:hover{background:#1e293b}
.note{margin-top:14px;font-size:13px;color:#94a3b8}
</style>
</head>
<body>
<div class="wrap"><div class="card">
<div class="icon">${t.icon}</div>
<h1>${heading}</h1>
<p>${message}</p>
${button ? `<form method="post"><button type="submit">${button}</button></form><p class="note">Opened this by mistake? Just close the page.</p>` : ''}
</div></div>
</body>
</html>`);
}

const PREVIEW_PAGE = {
    tone: 'info',
    heading: 'This is a test link',
    message: 'Unsubscribe links in previews and test emails do nothing. In the real campaign, every recipient gets a link of their own.'
};

const NOT_FOUND_PAGE = {
    tone: 'error',
    heading: 'Link not recognised',
    message: 'This unsubscribe link is incomplete or no longer exists. Reply to the email and ask to be removed instead — a person will take care of it.'
};

function donePage(r) {
    return {
        tone: 'done',
        heading: 'You are unsubscribed',
        message: `<strong>${escapeHtml(r.email)}</strong> will not receive any more of these emails from ${escapeHtml(r.tenant_name)}.`
    };
}

const unsubscribePage = async (req, res) => {
    try {
        if (req.params.token === 'preview') return page(res, 200, PREVIEW_PAGE);

        const r = await findRecipient(req.params.token);
        if (!r) return page(res, 404, NOT_FOUND_PAGE);
        if (r.unsubscribed_at) return page(res, 200, donePage(r));

        return page(res, 200, {
            tone: 'ask',
            heading: `Unsubscribe from ${escapeHtml(r.tenant_name)}?`,
            message: `<strong>${escapeHtml(r.email)}</strong> will stop receiving these emails.`,
            button: 'Unsubscribe'
        });
    } catch (error) {
        logger.error('unsubscribePage failed', { error: error.message });
        return page(res, 500, { tone: 'error', heading: 'Something went wrong', message: 'Please try the link again in a minute.' });
    }
};

const unsubscribe = async (req, res) => {
    try {
        if (req.params.token === 'preview') return page(res, 200, PREVIEW_PAGE);

        const r = await findRecipient(req.params.token);
        if (!r) return page(res, 404, NOT_FOUND_PAGE);

        const source = String((req.body || {})['List-Unsubscribe'] || '') === 'One-Click' ? 'one_click' : 'link';

        // Per customer, not per campaign: someone who asks to stop hearing from
        // a business means all of its campaigns, including ones not yet written.
        await POSTGRESQLService.PostgresTransaction(async (client) => {
            await client.query(
                `INSERT INTO campaign_unsubscribes (tenant_id, email, source, campaign_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (tenant_id, email) DO NOTHING`,
                [r.tenant_id, r.email, source, r.campaign_id]
            );
            await client.query(
                `UPDATE campaign_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1`,
                [r.id]
            );
        });

        logger.info('Campaign unsubscribe', { campaignId: r.campaign_id, tenantId: r.tenant_id, source });
        return page(res, 200, donePage(r));
    } catch (error) {
        logger.error('unsubscribe failed', { error: error.message });
        return page(res, 500, { tone: 'error', heading: 'Something went wrong', message: 'Please try again in a minute.' });
    }
};

/**
 * Always answers with the image, whatever happens to the bookkeeping — a
 * broken image icon in someone's inbox is worse than a missed count.
 *
 * Opens are approximate by nature: Apple Mail fetches images for privacy before
 * anyone reads the message, and clients that block images never report at all.
 */
const openPixel = async (req, res) => {
    const token = String(req.params.token || '');
    if (TOKEN.test(token)) {
        await POSTGRESQLService.PostgresAny(
            `UPDATE campaign_recipients
                SET opened_at = COALESCE(opened_at, now()), open_count = open_count + 1
              WHERE token = $1 AND status = 'sent'`,
            [token]
        ).catch((error) => logger.warn('Open could not be recorded', { error: error.message }));
    }

    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', PIXEL.length);
    // helmet's default same-origin policy would stop webmail rendering it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(PIXEL);
};

module.exports = { unsubscribePage, unsubscribe, openPixel };
