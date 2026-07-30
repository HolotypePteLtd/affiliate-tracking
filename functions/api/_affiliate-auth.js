// Stateless, signed tokens for the affiliate auth flow: magic-link login
// tokens (short-lived, emailed) and session cookies (long-lived, set as an
// HttpOnly cookie). Same HMAC-SHA256 shape as the download tokens in
// _download-token.js, reusing the shared crypto helpers. No storage needed —
// verification is purely signature + expiry.

import { importHmacKey, hmacHex, constantTimeCompare } from './_crypto-utils.js';

// Cookie name holding the affiliate session token.
export const SESSION_COOKIE = 'holotype_aff_session';

const MAGIC_LINK_TTL = 15 * 60;          // 15 minutes
const SESSION_TTL = 30 * 24 * 60 * 60;    // 30 days

// Parse a Cookie header into a { name: value } map.
export function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

// Sign a claims object: base64url(JSON(claims with exp)) "." hex(HMAC).
// `purpose` tags the token type so a magic-link token can't be replayed as a
// session token and vice versa.
async function sign(claims, secret, ttlSeconds) {
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
async function verify(token, secret, purpose) {
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

export function createMagicLink(affiliateId, secret, ttlSeconds = MAGIC_LINK_TTL) {
    return sign({ purpose: 'aff-login', sub: String(affiliateId) }, secret, ttlSeconds);
}

export async function verifyMagicLink(token, secret) {
    const claims = await verify(token, secret, 'aff-login');
    return claims ? claims.sub : null;
}

// --- Session tokens (set as a cookie, 30-day TTL) ---

export function createSession(affiliateId, secret, ttlSeconds = SESSION_TTL) {
    return sign({ purpose: 'aff-session', sub: String(affiliateId) }, secret, ttlSeconds);
}

export async function readSession(token, secret) {
    const claims = await verify(token, secret, 'aff-session');
    return claims ? claims.sub : null;
}

// Build a Set-Cookie header for the session token. Secure is only set when the
// request is HTTPS so local `wrangler dev` (http) still stores the cookie.
export function sessionCookieHeader(token, requestUrl, maxAge = SESSION_TTL) {
    const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/${secure}`;
}

export function clearSessionCookieHeader(requestUrl) {
    const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/${secure}`;
}

// base64url helpers (Workers-friendly; no Node Buffers).

function base64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
