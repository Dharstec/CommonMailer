/**
 * Turns raw SMTP failures into something a person can act on.
 *
 * Providers answer with codes like "535-5.7.8 Username and Password not
 * accepted", which is accurate and useless — it does not say that Gmail has not
 * accepted account passwords since 2022 and wants an App Password instead. Every
 * message here ends with the specific next step.
 *
 * The original text is always appended so nothing is hidden when the guess is
 * wrong.
 */

const RULES = [
    {
        // Authentication rejected.
        test: (m, code) => code === 'EAUTH' || /\b535\b|5\.7\.8|authentication fail|invalid login|not accepted/i.test(m),
        message: (m, host) => {
            if (/gmail|google/i.test(host)) {
                return 'Gmail rejected the username or password.\n\n'
                    + 'Gmail has not accepted normal account passwords for SMTP since 2022 — you need an App Password:\n'
                    + '  1. Turn on 2-Step Verification at myaccount.google.com/security\n'
                    + '  2. Create one at myaccount.google.com/apppasswords\n'
                    + '  3. Paste the 16 characters here with the spaces removed\n\n'
                    + 'Also check the username is the full email address, and that "From email" matches it.';
            }
            if (/office365|outlook|microsoft/i.test(host)) {
                return 'Microsoft rejected the username or password.\n\n'
                    + 'SMTP AUTH is disabled by default on Microsoft 365. An admin has to enable it for this '
                    + 'mailbox (Admin centre → Users → Mail → Manage email apps → Authenticated SMTP). '
                    + 'If security defaults are on, you also need an app password.';
            }
            if (/zoho/i.test(host)) {
                return 'Zoho rejected the username or password.\n\n'
                    + 'If two-factor authentication is on for this mailbox, generate an application-specific '
                    + 'password in Zoho and use that instead of the account password.';
            }
            return 'The mail server rejected the username or password.\n\n'
                + 'Check both, and whether this provider requires an app-specific password rather than the '
                + 'mailbox password.';
        }
    },
    {
        // Nothing listening / wrong host.
        test: (m, code) => ['ECONNREFUSED', 'ENOTFOUND', 'EDNS'].includes(code) || /getaddrinfo|econnrefused/i.test(m),
        message: () => 'Could not reach the mail server.\n\n'
            + 'Check the SMTP host is spelled correctly and the port is right — 587 with SSL/TLS off, '
            + 'or 465 with it on.'
    },
    {
        // Firewall or security group silently dropping the packets.
        test: (m, code) => code === 'ETIMEDOUT' || /timed? ?out/i.test(m),
        message: () => 'The connection timed out.\n\n'
                + 'Something is blocking outbound mail. AWS blocks port 25 on new accounts by default, and '
                + 'your security group must allow outbound 587 (or 465). Prefer 587 or 465 over 25.'
    },
    {
        // Implicit vs explicit TLS mismatch — the most common "it just hangs".
        test: (m) => /wrong version number|ssl|tls/i.test(m),
        message: () => 'TLS negotiation failed.\n\n'
            + 'This is almost always the port and the SSL/TLS switch disagreeing: '
            + 'port 465 needs SSL/TLS ON, port 587 needs it OFF.'
    },
    {
        // Authenticated fine, but not allowed to send as that address.
        test: (m) => /5\.7\.1|not allowed|sender.*denied|relay/i.test(m),
        message: () => 'The server accepted the login but refused the sender address.\n\n'
            + '"From email" must be a mailbox this account is allowed to send as. For Gmail that means the '
            + 'account address itself, or a verified alias.'
    }
];

function explainSmtpError(error, host = '') {
    const raw = String(error && error.message ? error.message : error || '');
    const code = error && error.code ? error.code : '';

    const rule = RULES.find((r) => r.test(raw, code));
    if (!rule) return raw;

    return `${rule.message(raw, host)}\n\nServer said: ${raw.split('\n')[0]}`;
}

module.exports = { explainSmtpError };
