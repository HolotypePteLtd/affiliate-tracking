import { describe, it, expect } from 'vitest';
import {
    SESSION_COOKIE,
    parseCookies,
    createMagicLink,
    verifyMagicLink,
    createSession,
    readSession,
    sessionCookieHeader,
    clearSessionCookieHeader,
} from '../../functions/api/_affiliate-auth.js';

const SECRET = 'test-secret-the-quick-brown-fox';

describe('parseCookies', () => {
    it('parses a basic cookie', () => {
        expect(parseCookies('foo=bar; baz=qux')).toEqual({ foo: 'bar', baz: 'qux' });
    });

    it('handles empty header', () => {
        expect(parseCookies('')).toEqual({});
        expect(parseCookies(null)).toEqual({});
        expect(parseCookies(undefined)).toEqual({});
    });

    it('skips malformed segments without =', () => {
        expect(parseCookies('foo=bar;justtext')).toEqual({ foo: 'bar' });
    });

    it('trims whitespace around names and values', () => {
        expect(parseCookies(' foo = bar ; baz = qux ')).toEqual({ foo: 'bar', baz: 'qux' });
    });

    it('returns empty for headers with only delimiters', () => {
        expect(parseCookies('; ; =')).toEqual({});
    });
});

describe('magic-link tokens', () => {
    it('round-trips a magic link token', async () => {
        const token = await createMagicLink(42, SECRET);
        const result = await verifyMagicLink(token, SECRET);
        expect(result).toBe('42');
    });

    it('rejects a token with the wrong purpose', async () => {
        const token = await createMagicLink(42, SECRET);
        // readSession looks for purpose='aff-session', but the token has 'aff-login'
        const result = await readSession(token, SECRET);
        expect(result).toBeNull();
    });

    it('rejects a tampered payload', async () => {
        const token = await createMagicLink(42, SECRET);
        const dot = token.lastIndexOf('.');
        const payload = token.slice(0, dot);
        const sig = token.slice(dot + 1);
        // Mutate the first character to guarantee a different payload
        const tamperedPayload = (payload[0] === 'a' ? 'b' : 'a') + payload.slice(1);
        const tamperedToken = `${tamperedPayload}.${sig}`;
        const result = await verifyMagicLink(tamperedToken, SECRET);
        expect(result).toBeNull();
    });

    it('rejects a tampered signature', async () => {
        const token = await createMagicLink(42, SECRET);
        const [payload] = token.split('.');
        const tamperedToken = `${payload}.deadbeef`;
        const result = await verifyMagicLink(tamperedToken, SECRET);
        expect(result).toBeNull();
    });

    it('rejects a malformed token', async () => {
        expect(await verifyMagicLink('', SECRET)).toBeNull();
        expect(await verifyMagicLink(null, SECRET)).toBeNull();
        expect(await verifyMagicLink('not.a-dot-separated', SECRET)).toBeNull();
    });

    it('rejects with the wrong secret', async () => {
        const token = await createMagicLink(42, SECRET);
        const result = await verifyMagicLink(token, 'different-secret');
        expect(result).toBeNull();
    });
});

describe('session tokens', () => {
    it('round-trips a session token', async () => {
        const token = await createSession(7, SECRET);
        const result = await readSession(token, SECRET);
        expect(result).toBe('7');
    });

    it('rejects when used as a magic link', async () => {
        const token = await createSession(7, SECRET);
        const result = await verifyMagicLink(token, SECRET);
        expect(result).toBeNull();
    });
});

describe('cookie headers', () => {
    it('sessionCookieHeader includes required flags', () => {
        const h = sessionCookieHeader('abc123', 'https://shop.example.com');
        expect(h).toContain('holotype_aff_session=abc123');
        expect(h).toContain('HttpOnly');
        expect(h).toContain('SameSite=Lax');
        expect(h).toContain('Max-Age=2592000');
        expect(h).toContain('Secure');
        expect(h).toContain('Path=/');
    });

    it('omits Secure for http requests', () => {
        const h = sessionCookieHeader('abc123', 'http://localhost:8787');
        expect(h).not.toContain('Secure');
    });

    it('clearSessionCookieHeader sets Max-Age=0', () => {
        const h = clearSessionCookieHeader('https://shop.example.com');
        expect(h).toContain('holotype_aff_session=');
        expect(h).toContain('Max-Age=0');
        expect(h).toContain('HttpOnly');
        expect(h).toContain('Secure');
    });
});
