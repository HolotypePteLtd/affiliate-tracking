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
// setting AFFILIATE_REF_COOKIE in their Worker env (e.g. to keep a legacy
// cookie name). Resolved per-call since env differs per environment.
export const DEFAULT_REF_COOKIE = 'affiliate_ref';
const REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function refCookieName(env) {
    return (env && env.AFFILIATE_REF_COOKIE) || DEFAULT_REF_COOKIE;
}

export async function applyAffiliateRef(request, env, respond) {
    if (!env.DB || typeof respond !== 'function') return null;
    const code = new URL(request.url).searchParams.get('ref');
    if (!code) return null;
    const cookieName = refCookieName(env);

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

    // One click per fresh referral: a visitor already carrying this code (page
    // reloads, multi-page browsing) is not a second click.
    const existing = parseCookies(request.headers.get('Cookie'))[cookieName];
    if (existing !== aff.code) {
        const ipHash = await hashIp(
            request.headers.get('cf-connecting-ip'),
            env.AFFILIATE_IP_SALT
        );
        try {
            await env.DB.prepare(
                'INSERT INTO clicks (affiliate_id, ip_hash, created_at) VALUES (?1,?2,?3)'
            ).bind(aff.id, ipHash, Date.now()).run();
        } catch (err) {
            console.error('Affiliate click insert failed:', err.message);
        }
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
    headers.append('Set-Cookie',
        `${cookieName}=${encodeURIComponent(aff.code)}; HttpOnly; SameSite=Lax; Max-Age=${REF_COOKIE_MAX_AGE}; Path=/`
    );
    return new Response(assetRes.body, { status: assetRes.status, headers });
}

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

async function hashIp(ip, salt) {
    if (!ip) return null;
    const data = new TextEncoder().encode(ip + (salt || ''));
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
