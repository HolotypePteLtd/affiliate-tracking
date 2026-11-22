// Short links.
//
// A link is https://<site>/r/<slug>. It redirects to its destination on the
// site with ?ref=<affiliate code>&aff_link=<slug>, so applyAffiliateRef sets
// the cookie on the site itself and records the click against the link. The
// same works from a separate short domain pointed at this Worker.
//
//   const linkRes = await handleAffiliateLink(request, env);
//   if (linkRes) return linkRes;
//
// Destinations are paths on the site (SITE_URL, or the request's origin),
// never another host, so a link can't be used as an open redirect.

export const DEFAULT_LINK_PREFIX = '/r/';
export const MAX_LINKS_PER_AFFILIATE = 100;
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function linkPrefix(env) {
    const prefix = env?.AFFILIATE_LINK_PREFIX || DEFAULT_LINK_PREFIX;
    return prefix.endsWith('/') ? prefix : prefix + '/';
}

function siteOrigin(env, request) {
    return new URL(env?.SITE_URL || request.url).origin;
}

export function linkUrl(env, request, slug) {
    const base = env?.AFFILIATE_LINK_BASE_URL || siteOrigin(env, request);
    return new URL(linkPrefix(env) + slug, base).toString();
}

export function validSlug(slug) {
    return typeof slug === 'string' && SLUG.test(slug);
}

export function validDestination(destination) {
    return typeof destination === 'string' && destination.length <= 512 &&
        destination.startsWith('/') && !destination.startsWith('//') && !/[\\\s]/.test(destination);
}

export async function handleAffiliateLink(request, env) {
    if (!env.DB || !['GET', 'HEAD'].includes(request.method)) return null;
    const url = new URL(request.url);
    const prefix = linkPrefix(env);
    if (!url.pathname.startsWith(prefix)) return null;
    const slug = url.pathname.slice(prefix.length).toLowerCase();
    if (!validSlug(slug)) return null;
    let link;
    try {
        link = await env.DB.prepare(`SELECT l.slug, l.destination, a.code FROM links l
            JOIN affiliates a ON a.id=l.affiliate_id
            WHERE l.slug=?1 AND l.status='active' AND a.status='active'`).bind(slug).first();
    } catch (err) {
        console.error('Affiliate link lookup failed:', err.message);
        return null;
    }
    if (!link) return null;
    const origin = siteOrigin(env, request);
    const target = new URL(link.destination, origin);
    if (target.origin !== origin) return null;
    // Keep the visitor's own query (utm_* and the like); ours wins on a clash.
    for (const [key, value] of url.searchParams) {
        if (!target.searchParams.has(key)) target.searchParams.append(key, value);
    }
    target.searchParams.set('ref', link.code);
    target.searchParams.set('aff_link', link.slug);
    return new Response(null, { status: 302, headers: {
        Location: target.toString(), 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    } });
}

// The active link with this slug, if it belongs to the affiliate.
export async function affiliateLink(env, affiliateId, slugOrId) {
    if (typeof slugOrId !== 'string' || !slugOrId) return null;
    return env.DB.prepare(`SELECT id, slug FROM links
        WHERE (slug=?1 OR id=?1) AND affiliate_id=?2 AND status='active'`).bind(slugOrId, affiliateId).first();
}

export async function listLinks(env, request, affiliateId) {
    const { results } = await env.DB.prepare(`
        SELECT l.id, l.slug, l.destination, l.campaign, l.status, l.created_at,
               (SELECT COUNT(*) FROM clicks c WHERE c.link_id=l.id) AS clicks,
               (SELECT COUNT(*) FROM conversions v WHERE v.link_id=l.id AND v.status!='refunded') AS conversions,
               (SELECT COALESCE(SUM(v.commission_cents),0) FROM conversions v
                 WHERE v.link_id=l.id AND v.status!='refunded') AS commission_cents
        FROM links l WHERE l.affiliate_id=?1 ORDER BY l.created_at DESC, l.id`).bind(affiliateId).all();
    return (results || []).map(row => ({ ...row, url: linkUrl(env, request, row.slug) }));
}

export async function createLink(env, request, affiliate, { slug, destination, campaign } = {}) {
    if (destination === undefined) destination = '/';
    if (!validDestination(destination)) {
        return { error: 'destination must be a path on this site, like /pricing', status: 400 };
    }
    if (campaign !== undefined && campaign !== null && (typeof campaign !== 'string' || campaign.length > 100)) {
        return { error: 'campaign must be text of up to 100 characters', status: 400 };
    }
    if (slug === undefined || slug === null || slug === '') {
        slug = `${affiliate.code}-${crypto.randomUUID().slice(0, 6)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }
    if (!validSlug(slug)) {
        return { error: 'slug must be 2–64 lowercase letters, digits or dashes', status: 400 };
    }
    const id = crypto.randomUUID();
    const result = await env.DB.prepare(`INSERT INTO links (id, affiliate_id, slug, destination, campaign, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE (SELECT COUNT(*) FROM links WHERE affiliate_id=?2 AND status='active') < ?7
        ON CONFLICT(slug) DO NOTHING`)
        .bind(id, affiliate.id, slug, destination, campaign?.trim() || null, Date.now(), MAX_LINKS_PER_AFFILIATE).run();
    if (!result.meta?.changes) {
        const taken = await env.DB.prepare('SELECT 1 FROM links WHERE slug=?1').bind(slug).first();
        return taken ? { error: 'That slug is already taken', status: 409 }
            : { error: `An affiliate can have up to ${MAX_LINKS_PER_AFFILIATE} active links`, status: 409 };
    }
    return { link: { id, slug, destination, campaign: campaign?.trim() || null, status: 'active', url: linkUrl(env, request, slug) } };
}

export async function archiveLink(env, affiliateId, id) {
    if (typeof id !== 'string' || !id) return false;
    const result = await env.DB.prepare(`UPDATE links SET status='archived' WHERE id=?1 AND affiliate_id=?2 AND status='active'`)
        .bind(id, affiliateId).run();
    return Boolean(result.meta?.changes);
}
