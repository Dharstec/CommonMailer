/**
 * AES-256-GCM at-rest encryption for customer SMTP passwords and reCAPTCHA
 * secrets.
 *
 * GCM (not CBC) is deliberate: it authenticates the ciphertext, so a tampered
 * row fails to decrypt instead of silently yielding garbage that we would then
 * hand to an SMTP server. Every encrypt uses a fresh random IV, so the same
 * password stored twice produces different ciphertext.
 *
 * Stored format:  v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>
 * The version prefix leaves room to rotate the scheme later without guessing.
 */
const crypto = require('crypto');
require('dotenv').config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV is the GCM standard
const VERSION = 'v1';

let cachedKey = null;

function getKey() {
    if (cachedKey) return cachedKey;

    const raw = (process.env.ENCRYPTION_KEY || '').trim();
    if (!raw) {
        throw new Error(
            'ENCRYPTION_KEY is not set. Generate one with:\n' +
            '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
        );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
    }

    cachedKey = Buffer.from(raw, 'hex');
    return cachedKey;
}

/** Throws at boot if the key is missing/malformed, rather than at first send. */
function assertKeyReady() {
    getKey();
}

function encrypt(plainText) {
    if (plainText === null || plainText === undefined || plainText === '') return null;

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(String(plainText), 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return [VERSION, iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(payload) {
    if (!payload) return null;

    const parts = String(payload).split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('Stored secret is not in the expected v1 format.');
    }

    const [, ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

    try {
        return Buffer.concat([
            decipher.update(Buffer.from(dataHex, 'hex')),
            decipher.final()
        ]).toString('utf8');
    } catch (err) {
        // Wrong ENCRYPTION_KEY, or the row was tampered with.
        throw new Error('Could not decrypt stored secret — check ENCRYPTION_KEY has not changed.');
    }
}

module.exports = { encrypt, decrypt, assertKeyReady };
