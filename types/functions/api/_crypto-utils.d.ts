/**
 * Import a raw secret string as an HMAC key.
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
export declare function importHmacKey(secret: string): Promise<CryptoKey>;
/**
 * Compute the HMAC-SHA256 of `message`, returned as a hex string.
 * @param {CryptoKey} key
 * @param {string} message
 * @returns {Promise<string>}
 */
export declare function hmacHex(key: CryptoKey, message: string): Promise<string>;
/**
 * Encode an ArrayBuffer/TypedArray as lowercase hex.
 * @param {ArrayBuffer | ArrayBufferView} buffer
 * @returns {string}
 */
export declare function hexEncode(buffer: ArrayBuffer): string;
/**
 * Constant-time string comparison to avoid timing-side-channel attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export declare function constantTimeCompare(a: string, b: string): boolean;
