// Click analytics and the referral funnel.
//
// Each click stores its country (Cloudflare's request.cf.country), a device
// class and the referring site's host (never the full referrer URL). The
// dashboards read them from D1, so they need no API token. With an Analytics
// Engine binding named AFFILIATE_ANALYTICS, every click is also written there
// for high-volume analysis in your own Cloudflare account.
//
// The funnel per affiliate: clicks → signups (when signup referrals are in
// use) → customers → sales → revenue → commission pending/approved/paid.

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_DAYS = 366;

export function deviceClass(userAgent) {
    const ua = userAgent || '';
    if (!ua) return null;
    if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return 'tablet';
    if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
    return 'desktop';
}

export function referrerHost(request) {
    const referrer = request.headers.get('referer');
    if (!referrer) return null;
    try {
        const host = new URL(referrer).hostname.toLowerCase();
        return host && host !== new URL(request.url).hostname.toLowerCase() ? host.slice(0, 253) : null;
    } catch {
        return null;
    }
}

export function clickDetails(request) {
    const country = request.cf?.country;
    return {
        country: typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null,
        device: deviceClass(request.headers.get('user-agent')),
        referrer_host: referrerHost(request),
    };
}

export function writeClickEvent(env, { affiliateId, code, details }) {
    if (typeof env.AFFILIATE_ANALYTICS?.writeDataPoint !== 'function') return;
    try {
        env.AFFILIATE_ANALYTICS.writeDataPoint({
            indexes: [String(affiliateId)],
            blobs: [code, details.country || '', details.device || '', details.referrer_host || ''],
            doubles: [1],
        });
    } catch (err) {
        console.error('Affiliate analytics write failed:', err.message);
    }
}

export function statsRange(params, now = Date.now()) {
    const raw = params.get('days');
    const days = raw === null ? 30 : Number(raw);
    if (!/^\d+$/.test(String(raw ?? '30')) || !Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) return null;
    const end = now;
    const start = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), new Date(end).getUTCDate()) - (days - 1) * DAY_MS;
    return { days, start, end };
}

async function hasTable(env, name) {
    return Boolean(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1").bind(name).first());
}

export async function affiliateStats(env, { affiliateId = null, range }) {
    const db = env.DB;
    const { start, end, days } = range;
    const scope = '(?1 IS NULL OR affiliate_id=?1) AND created_at>=?2 AND created_at<=?3';
    const bind = [affiliateId, start, end];
    const [hasReferrals, hasLinks] = await Promise.all([hasTable(env, 'referrals'), hasTable(env, 'links')]);

    const [affiliates, clicks, sales, money, signups, byDay, countries, devices, referrers] = await Promise.all([
        db.prepare(`SELECT id, code, name FROM affiliates WHERE (?1 IS NULL OR id=?1) AND status!='pending' ORDER BY id`).bind(affiliateId).all(),
        db.prepare(`SELECT affiliate_id, COUNT(*) AS n FROM clicks WHERE ${scope} GROUP BY affiliate_id`).bind(...bind).all(),
        db.prepare(`SELECT affiliate_id, COUNT(*) AS sales,
                    COUNT(DISTINCT lower(customer_email)) AS customers
                    FROM conversions WHERE ${scope} AND status!='refunded' GROUP BY affiliate_id`).bind(...bind).all(),
        db.prepare(`SELECT affiliate_id, COALESCE(currency,'') AS currency,
                    SUM(CASE WHEN status!='refunded' THEN amount_cents ELSE 0 END) AS revenue_cents,
                    SUM(CASE WHEN status='pending' THEN commission_cents ELSE 0 END) AS pending_cents,
                    SUM(CASE WHEN status='approved' THEN commission_cents ELSE 0 END) AS approved_cents,
                    SUM(CASE WHEN status IN ('paying','paid') THEN commission_cents ELSE 0 END) AS paid_cents,
                    SUM(CASE WHEN status='refunded' THEN commission_cents ELSE 0 END) AS refunded_cents
                    FROM conversions WHERE ${scope} GROUP BY affiliate_id, currency`).bind(...bind).all(),
        hasReferrals
            ? db.prepare(`SELECT affiliate_id, COUNT(*) AS n FROM referrals WHERE ${scope} GROUP BY affiliate_id`).bind(...bind).all()
            : null,
        db.prepare(`SELECT CAST((created_at - ?2) / ${DAY_MS} AS INTEGER) AS day, COUNT(*) AS n FROM clicks WHERE ${scope} GROUP BY day`).bind(...bind).all(),
        db.prepare(`SELECT country AS value, COUNT(*) AS n FROM clicks WHERE ${scope} AND country IS NOT NULL GROUP BY country ORDER BY n DESC, value LIMIT 10`).bind(...bind).all(),
        db.prepare(`SELECT device AS value, COUNT(*) AS n FROM clicks WHERE ${scope} AND device IS NOT NULL GROUP BY device ORDER BY n DESC, value LIMIT 10`).bind(...bind).all(),
        db.prepare(`SELECT referrer_host AS value, COUNT(*) AS n FROM clicks WHERE ${scope} AND referrer_host IS NOT NULL GROUP BY referrer_host ORDER BY n DESC, value LIMIT 10`).bind(...bind).all(),
    ]);

    const index = (rows, key = 'affiliate_id') => new Map((rows?.results || []).map(row => [row[key], row]));
    const clickMap = index(clicks), saleMap = index(sales), signupMap = signups ? index(signups) : null;
    const moneyMap = new Map();
    for (const row of money.results || []) {
        if (!moneyMap.has(row.affiliate_id)) moneyMap.set(row.affiliate_id, []);
        const { affiliate_id: _, currency, ...amounts } = row;
        moneyMap.get(row.affiliate_id).push({ currency: currency || null, ...amounts });
    }
    const funnel = (affiliates.results || []).map(a => ({
        affiliate_id: a.id, code: a.code, name: a.name,
        clicks: clickMap.get(a.id)?.n || 0,
        signups: signupMap ? signupMap.get(a.id)?.n || 0 : null,
        customers: saleMap.get(a.id)?.customers || 0,
        sales: saleMap.get(a.id)?.sales || 0,
        money: moneyMap.get(a.id) || [],
    }));

    const perDay = new Map((byDay.results || []).map(row => [row.day, row.n]));
    const clicksByDay = Array.from({ length: days }, (_, i) => ({
        date: new Date(start + i * DAY_MS).toISOString().slice(0, 10), clicks: perDay.get(i) || 0,
    }));
    const top = rows => (rows.results || []).map(row => ({ value: row.value, clicks: row.n }));

    let links = null;
    if (hasLinks && affiliateId !== null) {
        const { results } = await db.prepare(`SELECT l.slug, l.campaign,
                (SELECT COUNT(*) FROM clicks c WHERE c.link_id=l.id AND c.created_at>=?2 AND c.created_at<=?3) AS clicks,
                (SELECT COUNT(*) FROM conversions v WHERE v.link_id=l.id AND v.status!='refunded' AND v.created_at>=?2 AND v.created_at<=?3) AS sales
            FROM links l WHERE l.affiliate_id=?1 ORDER BY clicks DESC, l.slug`).bind(affiliateId, start, end).all();
        links = results || [];
    }
    return {
        range: { days, start: new Date(start).toISOString(), end: new Date(end).toISOString() },
        funnel, clicks_by_day: clicksByDay,
        top_countries: top(countries), top_devices: top(devices), top_referrers: top(referrers),
        ...(links ? { links } : {}),
    };
}
