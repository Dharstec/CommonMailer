/**
 * The one URL a customer website posts to, derived from the form key.
 *
 * Kept in a helper because it is returned by several endpoints and shown in the
 * admin panel — if the URL shape ever changes, it changes here only.
 */
require('dotenv').config();

function baseUrl() {
    return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

function buildLinks(formKey) {
    return {
        submit_url: `${baseUrl()}/api/form/${formKey}`
    };
}

/** Per-recipient links written into every campaign message. */
function campaignLinks(token) {
    return {
        unsubscribe: `${baseUrl()}/api/c/${token}/unsubscribe`,
        open: `${baseUrl()}/api/c/${token}/open.gif`
    };
}

module.exports = { buildLinks, campaignLinks, baseUrl };
