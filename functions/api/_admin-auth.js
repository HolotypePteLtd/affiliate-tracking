import { hmacHex, constantTimeCompare } from './_crypto-utils.js';
import { readCookieValue } from './_affiliate-auth.js';

export const ADMIN_SESSION_COOKIE = 'aff_admin_session';
const TTL = 8 * 60 * 60;
const encoder = new TextEncoder();

async function deriveAdminKey(secret) {
    const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(`aff-admin-session-v1:${secret}`));
    return crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function createAdminSession(secret, ttl = TTL) {
    const payload = btoa(JSON.stringify({ purpose: 'aff-admin', exp: Math.floor(Date.now() / 1000) + ttl }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${payload}.${await hmacHex(await deriveAdminKey(secret), payload)}`;
}

export async function readAdminSession(request, secret) {
    const token = readCookieValue(request.headers.get('Cookie'), ADMIN_SESSION_COOKIE);
    if (!token || !secret) return false;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return false;
    const expected = await hmacHex(await deriveAdminKey(secret), payload);
    if (!constantTimeCompare(signature, expected)) return false;
    try {
        const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
        return claims.purpose === 'aff-admin' && typeof claims.exp === 'number'
            && claims.exp > Math.floor(Date.now() / 1000);
    } catch { return false; }
}

export function adminSessionCookieHeader(token, requestUrl, maxAge = TTL) {
    const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
    return `${ADMIN_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/${secure}`;
}

export function isSameOrigin(request) {
    return request.headers.get('Origin') === new URL(request.url).origin;
}
