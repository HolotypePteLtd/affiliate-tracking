// Shared Web Crypto helpers for signature verification and token signing.
// Used by the Stripe webhook verifier (_webhook-utils.js) and the download-token
// helper (_download-token.js).

const encoder = new TextEncoder();

/**
 * Import a raw secret string as an HMAC key.
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
export async function importHmacKey(secret) {
    return crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
}

/**
 * Compute the HMAC-SHA256 of `message`, returned as a hex string.
 * @param {CryptoKey} key
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function hmacHex(key, message) {
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return hexEncode(mac);
}

/**
 * Encode an ArrayBuffer/TypedArray as lowercase hex.
 * @param {ArrayBuffer | ArrayBufferView} buffer
 * @returns {string}
 */
export function hexEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Constant-time string comparison to avoid timing-side-channel attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeCompare(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
