// Signed affiliate tokens. D1 tracks redeemed magic links and the current
// session version for each affiliate.

import { importHmacKey, hmacHex, constantTimeCompare } from './_crypto-utils.ts';
import { authCookieHeader, hostCookieName } from '../../src/cookie.ts';

// Cookie name holding the affiliate session token.
export const SESSION_COOKIE = '__Host-aff_session';

const MAGIC_LINK_TTL = 15 * 60;          // 15 minutes
const SESSION_TTL = 30 * 24 * 60 * 60;    // 30 days

// Parse a Cookie header into a { name: value } map.
export function parseCookies(header: string | null) {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = v;
    }
    return out;
}

// Read a single cookie value, returning null if absent or if conflicting
// duplicate cookies with the same name are present (cookie-tossing defense).
export function readCookieValue(header: string | null, name: string): string | null {
    if (!header) return null;
    const values = new Set<string>();
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() !== name) continue;
        values.add(part.slice(idx + 1).trim());
    }
    if (values.size !== 1) return null;
    return [...values][0] || null;
}

// Sign a claims object: base64url(JSON(claims with exp)) "." hex(HMAC).
// `purpose` tags the token type so a magic-link token can't be replayed as a
// session token and vice versa.
async function sign(claims: Record<string, unknown>, secret: string, ttlSeconds: number) {
    if (!secret) throw new Error('AFFILIATE_SESSION_SECRET is not configured');
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = JSON.stringify({ ...claims, exp });
    const encodedPayload = base64urlEncode(payload);
    const key = await importHmacKey(secret);
    const sig = await hmacHex(key, encodedPayload);
    return `${encodedPayload}.${sig}`;
}

// Verify a token: returns the claims (minus exp) on success, or null on any
// failure (bad signature, wrong purpose, expired, malformed). Never throws.
async function verify(token: string, secret: string, purpose: string) {
    if (!token || typeof token !== 'string' || !secret) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const encodedPayload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const key = await importHmacKey(secret);
    const expectedSig = await hmacHex(key, encodedPayload);
    if (!constantTimeCompare(sig, expectedSig)) return null;

    let claims;
    try {
        claims = JSON.parse(base64urlDecode(encodedPayload));
    } catch {
        return null;
    }
    if (claims.purpose !== purpose) return null;
    if (typeof claims.exp !== 'number' || Math.floor(Date.now() / 1000) >= claims.exp) return null;
    return claims;
}

// --- Magic-link login tokens (emailed, 15-min TTL) ---

export function createMagicLink(affiliateId: number, secret: string, version = 0) {
    return sign({ purpose: 'aff-login', sub: String(affiliateId), version, jti: crypto.randomUUID() }, secret, MAGIC_LINK_TTL);
}

export async function verifyMagicLink(token: string, secret: string) {
    const claims = await verify(token, secret, 'aff-login');
    return typeof claims?.jti === 'string' && Number.isSafeInteger(claims.version) ? claims : null;
}

// --- Session tokens (set as a cookie, 30-day TTL) ---

export function createSession(affiliateId: number, secret: string, version = 0) {
    return sign({ purpose: 'aff-session', sub: String(affiliateId), version }, secret, SESSION_TTL);
}

export async function readSession(token: string, secret: string) {
    const claims = await verify(token, secret, 'aff-session');
    return Number.isSafeInteger(claims?.version) ? claims : null;
}

export function affiliateSessionToken(request: Request) {
    return readCookieValue(request.headers.get('Cookie'), hostCookieName(SESSION_COOKIE, request.url));
}

export function sessionCookieHeader(token: string, requestUrl: string, maxAge = SESSION_TTL) {
    return authCookieHeader(SESSION_COOKIE, token, requestUrl, maxAge, 'Lax');
}

export function clearSessionCookieHeader(requestUrl: string) {
    return sessionCookieHeader('', requestUrl, 0);
}

// base64url helpers (Workers-friendly; no Node Buffers).

function base64urlEncode(str: string) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
