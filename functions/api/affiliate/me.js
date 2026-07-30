//   GET /api/affiliate/me
//     Returns the logged-in affiliate's dashboard data as JSON: referral
//     link, click count, recent conversions, and per-status commission totals.
//     401 when not authenticated (the dashboard page redirects to /affiliates/).

import { readSession, parseCookies, SESSION_COOKIE } from '../_affiliate-auth.js';

export async function onRequestGet(context) {
    const env = context.env;
    if (!env.DB || !env.AFFILIATE_SESSION_SECRET) {
        return Response.json({ error: 'Affiliate login is not configured' }, { status: 503 });
    }

    const cookies = parseCookies(context.request.headers.get('Cookie'));
    const affiliateId = await readSession(cookies[SESSION_COOKIE], env.AFFILIATE_SESSION_SECRET);
    if (!affiliateId) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    const db = env.DB;
    const aff = await db.prepare(
        'SELECT id, code, name, commission_pct, status, stripe_account_id FROM affiliates WHERE id=?1'
    )
        .bind(affiliateId)
        .first();
    if (!aff) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    const [clicks, conversions, totals] = await Promise.all([
        db.prepare('SELECT COUNT(*) as n FROM clicks WHERE affiliate_id=?1')
            .bind(affiliateId).first(),
        db.prepare(
            `SELECT status, amount_cents, commission_cents, customer_email, created_at
             FROM conversions WHERE affiliate_id=?1
             ORDER BY created_at DESC LIMIT 100`
        ).bind(affiliateId).all(),
        db.prepare(
            `SELECT status, SUM(commission_cents) as commission, COUNT(*) as n
             FROM conversions WHERE affiliate_id=?1 GROUP BY status`
        ).bind(affiliateId).all(),
    ]);

    const origin = env.SITE_URL || new URL(context.request.url).origin;

    return Response.json({
        code: aff.code,
        name: aff.name,
        status: aff.status,
        commission_pct: aff.commission_pct,
        stripe_account_id: aff.stripe_account_id || null,
        referral_link: `${origin}/?ref=${encodeURIComponent(aff.code)}`,
        clicks: clicks?.n || 0,
        conversions: (conversions.results || []).map((r) => ({
            status: r.status,
            amount_cents: r.amount_cents,
            commission_cents: r.commission_cents,
            customer_email: r.customer_email,
            created_at: r.created_at,
        })),
        totals: (totals.results || []).reduce((acc, r) => {
            acc[r.status] = { commission_cents: r.commission || 0, count: r.n };
            return acc;
        }, {}),
    });
}
