// The affiliate ref middleware.
//
// Worker entry point passes the asset fallthrough as `respond` so the cookie
// can be appended to whatever the site would have served anyway (page, 404,
// etc.). Every failure mode — no DB binding, unknown/inactive code, asset
// fetch error — returns null so the caller's normal flow is untouched.
//
//   const refRes = await applyAffiliateRef(request, env, () => env.ASSETS.fetch(request));
//   if (refRes) return refRes;

// Attribution cookie name. Neutral default; consumers brand it per site by
// setting AFFILIATE_REF_COOKIE in their Worker env. Use a __Host- name on
// HTTPS and AFFILIATE_REF_LEGACY_COOKIE for a read-only migration fallback.
// Resolved per-call since env differs per environment.
import { hostCookieName } from './cookie.js';
import { affiliateLink } from './links.js';

export const DEFAULT_REF_COOKIE = 'affiliate_ref';
const REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function refCookieName(env, request) {
    const name = (env && env.AFFILIATE_REF_COOKIE) || DEFAULT_REF_COOKIE;
    return request ? hostCookieName(name, request.url) : name;
}

// Which of the affiliate's links the visitor came through (src/links.js).
export function linkCookieName(env, request) {
    const name = ((env && env.AFFILIATE_REF_COOKIE) || DEFAULT_REF_COOKIE) + '_link';
    return request ? hostCookieName(name, request.url) : name;
}

export function readAffiliateLink(request, env) {
    const cookie = referralCookie(request.headers.get('Cookie'), linkCookieName(env, request));
    return cookie.present && !cookie.invalid && cookie.values.size === 1 ? [...cookie.values][0] || null : null;
}

// Cookie headers contain no path/domain/creation-time information. Never use
// their ordering to select between conflicting referrals. A present current
// cookie takes precedence over legacy cookies, even if invalid or ambiguous.
export function readAffiliateRef(request, env) {
    const names = new Set([refCookieName(env, request), env?.AFFILIATE_REF_LEGACY_COOKIE]);
    const header = request.headers.get('Cookie');
    for (const name of names) {
        if (!name) continue;
        const cookie = referralCookie(header, name);
        if (!cookie.present) continue;
        if (cookie.values.size > 1) {
            console.warn(JSON.stringify({ event: 'affiliate_ref_cookie_conflict', cookie_name: name }));
        }
        if (cookie.invalid || cookie.values.size !== 1) return null;
        return [...cookie.values][0] || null;
    }
    return null;
}

function referralCookie(header, name) {
    const cookie = { present: false, invalid: false, values: new Set() };
    for (const part of (header || '').split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1 || part.slice(0, idx).trim() !== name) continue;
        cookie.present = true;
        try {
            cookie.values.add(decodeURIComponent(part.slice(idx + 1).trim()));
        } catch {
            cookie.invalid = true;
        }
    }
    return cookie;
}

export async function applyAffiliateRef(request, env, respond, ctx) {
    if (!env.DB || typeof respond !== 'function' || request.method !== 'GET') return null;
    const searchParams = new URL(request.url).searchParams;
    const code = searchParams.get('ref');
    if (!code) return null;
    const cookieName = refCookieName(env, request);

    let aff;
    try {
        aff = await env.DB.prepare(
            "SELECT id, code FROM affiliates WHERE code=?1 AND status='active'"
        ).bind(code).first();
    } catch (err) {
        console.error('Affiliate referral lookup failed:', err.message);
        return null;
    }
    if (!aff) return null;

    // A short link adds aff_link=<slug>; only the affiliate's own active links count.
    let link = null;
    const linkSlug = searchParams.get('aff_link');
    if (linkSlug) {
        try {
            link = await affiliateLink(env, aff.id, linkSlug.toLowerCase());
        } catch (err) {
            console.error('Affiliate link lookup failed:', err.message);
        }
    }

    // One click per fresh referral: a visitor already carrying this code and
    // link (page reloads, multi-page browsing) is not a second click.
    const existing = readAffiliateRef(request, env);
    if (existing !== aff.code || (link && readAffiliateLink(request, env) !== link.id)) {
        const click = recordClick(request, env, aff.id, link?.id || null);
        if (ctx?.waitUntil) ctx.waitUntil(click);
        else await click;
    }

    let assetRes;
    try {
        assetRes = await respond();
    } catch (err) {
        console.error('Affiliate asset fetch failed:', err.message);
        return null;
    }
    if (!(assetRes instanceof Response)) return null;
    const headers = new Headers(assetRes.headers);
    headers.set('Cache-Control', 'private, no-cache');
    const secure = new URL(request.url).protocol === 'https:' || cookieName.startsWith('__Host-');
    const attributes = `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
    headers.append('Set-Cookie',
        `${cookieName}=${encodeURIComponent(aff.code)}; Max-Age=${REF_COOKIE_MAX_AGE}; ${attributes}`
    );
    // Retire the known host-only, root-path legacy cookie on a fresh referral.
    // Other legacy scopes are unknown; the current cookie always outranks them.
    // Remember the link, or forget an earlier one when this visit used none.
    if (link) {
        headers.append('Set-Cookie', `${linkCookieName(env, request)}=${encodeURIComponent(link.id)}; Max-Age=${REF_COOKIE_MAX_AGE}; ${attributes}`);
    } else if (readAffiliateLink(request, env)) {
        headers.append('Set-Cookie', `${linkCookieName(env, request)}=; Max-Age=0; ${attributes}`);
    }
    const legacyName = env.AFFILIATE_REF_LEGACY_COOKIE;
    if (legacyName && legacyName !== cookieName) {
        headers.append('Set-Cookie', `${legacyName}=; Max-Age=0; ${attributes}`);
    }
    return new Response(assetRes.body, { status: assetRes.status, headers });
}

async function recordClick(request, env, affiliateId, linkId) {
    try {
        const ipHash = await hashIp(request.headers.get('cf-connecting-ip'), env.AFFILIATE_IP_SALT);
        await env.DB.prepare(
            'INSERT INTO clicks (affiliate_id, ip_hash, created_at, link_id) VALUES (?1,?2,?3,?4)'
        ).bind(affiliateId, ipHash, Date.now(), linkId).run();
    } catch (err) {
        console.error('Affiliate click insert failed:', err.message);
    }
}

async function hashIp(ip, salt) {
    if (!ip) return null;
    const data = new TextEncoder().encode(ip + (salt || ''));
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
