import { describe, it, expect } from 'vitest';
import {
    constantTimeCompare,
    importHmacKey,
    hmacHex,
    hexEncode,
} from '../../functions/api/_crypto-utils.js';

describe('constantTimeCompare', () => {
    it('returns true for equal strings', () => {
        expect(constantTimeCompare('abc', 'abc')).toBe(true);
    });

    it('returns false for different lengths', () => {
        expect(constantTimeCompare('abc', 'abcd')).toBe(false);
    });

    it('returns false for same-length different strings', () => {
        expect(constantTimeCompare('abc', 'abd')).toBe(false);
    });

    it('returns false for empty vs non-empty', () => {
        expect(constantTimeCompare('', 'a')).toBe(false);
    });

    it('returns true for both empty', () => {
        expect(constantTimeCompare('', '')).toBe(true);
    });
});

describe('hexEncode', () => {
    it('encodes a buffer as lowercase hex', () => {
        const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
        expect(hexEncode(buf)).toBe('deadbeef');
    });

    it('handles empty buffer', () => {
        expect(hexEncode(new Uint8Array(0).buffer)).toBe('');
    });
});

describe('importHmacKey + hmacHex', () => {
    it('imports a key and signs a message deterministically', async () => {
        const key = await importHmacKey('test-secret');
        const sig1 = await hmacHex(key, 'hello');
        const sig2 = await hmacHex(key, 'hello');
        expect(sig1).toBe(sig2); // deterministic
        expect(sig1.length).toBeGreaterThan(0);
    });

    it('produces different signatures for different messages', async () => {
        const key = await importHmacKey('test-secret');
        const sigA = await hmacHex(key, 'message-a');
        const sigB = await hmacHex(key, 'message-b');
        expect(sigA).not.toBe(sigB);
    });

    it('produces different signatures for different secrets', async () => {
        const keyA = await importHmacKey('secret-a');
        const keyB = await importHmacKey('secret-b');
        const sigA = await hmacHex(keyA, 'same');
        const sigB = await hmacHex(keyB, 'same');
        expect(sigA).not.toBe(sigB);
    });
});
