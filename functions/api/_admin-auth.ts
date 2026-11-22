import { hmacHex, constantTimeCompare } from './_crypto-utils.ts';
import { readCookieValue } from './_affiliate-auth.ts';
import { authCookieHeader, hostCookieName } from '../../src/cookie.ts';

export const ADMIN_SESSION_COOKIE = '__Host-aff_admin_session';
const TTL = 8 * 60 * 60;
const encoder = new TextEncoder();

async function deriveAdminKey(secret: string) {
    const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(`aff-admin-session-v1:${secret}`));
    return crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function createAdminSession(secret: string, ttl = TTL) {
    const payload = btoa(JSON.stringify({ purpose: 'aff-admin', exp: Math.floor(Date.now() / 1000) + ttl }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${payload}.${await hmacHex(await deriveAdminKey(secret), payload)}`;
}

export async function readAdminSession(request: Request, secret: string) {
    const token = readCookieValue(request.headers.get('Cookie'), hostCookieName(ADMIN_SESSION_COOKIE, request.url));
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

export function adminSessionCookieHeader(token: string, requestUrl: string, maxAge = TTL) {
    return authCookieHeader(ADMIN_SESSION_COOKIE, token, requestUrl, maxAge, 'Strict');
}

export function isSameOrigin(request: Request) {
    return request.headers.get('Origin') === new URL(request.url).origin;
}
