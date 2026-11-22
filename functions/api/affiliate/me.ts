// GET /api/affiliate/me: authenticated purchase and payout history.
import { signedInAffiliate, positiveInteger, conversionFilter, pagination, reference, CONVERSION_COLUMNS, publicConversion } from './_dashboard.ts';
import { currencyCode, currencyDecimals } from '../../../src/money.ts';
import type { AffiliateRouteContext, ConversionsRow, PayoutsRow } from '../../../src/types.ts';

export async function onRequestGet(context: AffiliateRouteContext) {
    const aff = await signedInAffiliate(context.request, context.env);
    if (aff instanceof Response) return aff;
    const db = context.env.DB;
    if (!db) return Response.json({ error: 'Affiliate login is not configured' }, { status: 503 });
    const params = new URL(context.request.url).searchParams;
    const requestedPage = positiveInteger(params, 'page', 1);
    const perPage = positiveInteger(params, 'per_page', 100, 100);
    const payoutPage = positiveInteger(params, 'payout_page', 1);
    const payoutPerPage = positiveInteger(params, 'payout_per_page', 25, 100);
    if (requestedPage === null || perPage === null || payoutPage === null || payoutPerPage === null) {
        return Response.json({ error: 'Invalid pagination' }, { status: 400 });
    }
    const filter = conversionFilter(params, aff.id);
    if (filter instanceof Response) return filter;
    const { where, bindings } = filter;
    const [clicks, count, totals, payoutCount, products] = await Promise.all([
        db.prepare('SELECT COUNT(*) as n FROM clicks WHERE affiliate_id=?1').bind(aff.id).first<{ n: number }>(),
        db.prepare('SELECT COUNT(*) as n FROM conversions WHERE ' + where).bind(...bindings).first<{ n: number }>(),
        db.prepare('SELECT status, SUM(commission_cents) as commission, COUNT(*) as n FROM conversions WHERE affiliate_id=?1 GROUP BY status').bind(aff.id).all<{ status: string; commission: number | null; n: number }>(),
        db.prepare('SELECT COUNT(*) as n FROM payouts WHERE affiliate_id=?1').bind(aff.id).first<{ n: number }>(),
        db.prepare(`SELECT json_extract(item.value,'$.product_id') AS id,
                    MAX(json_extract(item.value,'$.name')) AS name
                    FROM conversions, json_each(conversions.items_json) item
                    WHERE affiliate_id=?1 AND json_extract(item.value,'$.product_id') IS NOT NULL
                    GROUP BY json_extract(item.value,'$.product_id') ORDER BY name COLLATE NOCASE`).bind(aff.id).all<{ id: string; name: string | null }>(),
    ]);
    const pages = pagination(requestedPage, perPage, count?.n || 0);
    const payoutPages = pagination(payoutPage, payoutPerPage, payoutCount?.n || 0);
    const [conversions, payouts] = await Promise.all([
        db.prepare(`SELECT ${CONVERSION_COLUMNS} FROM conversions WHERE ${where}
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`)
            .bind(...bindings, perPage, (pages.page - 1) * perPage).all<ConversionsRow>(),
        db.prepare(`SELECT p.id,p.amount_cents,p.currency,p.status,p.created_at,
                    COALESCE(p.paid_at,(SELECT MAX(c.paid_at) FROM conversions c WHERE c.payout_id=p.id)) AS paid_at,
                    (SELECT COUNT(*) FROM conversions c WHERE c.payout_id=p.id) AS conversions
                    FROM payouts p WHERE p.affiliate_id=?1
                    ORDER BY p.created_at DESC,p.id DESC LIMIT ?2 OFFSET ?3`)
            .bind(aff.id, payoutPerPage, (payoutPages.page - 1) * payoutPerPage).all<Pick<PayoutsRow, 'id' | 'amount_cents' | 'currency' | 'status' | 'created_at' | 'paid_at'> & { conversions: number }>(),
    ]);
    const origin = context.env.SITE_URL || new URL(context.request.url).origin;
    return Response.json({
        code: aff.code, name: aff.name, email: aff.email, status: aff.status,
        commission_pct: aff.commission_pct, stripe_account_id: aff.stripe_account_id || null,
        referral_link: `${origin}/?ref=${encodeURIComponent(aff.code)}`,
        clicks: clicks?.n || 0,
        pagination: pages, conversions: (conversions.results || []).map(publicConversion),
        products: (products.results || []).map(row => ({ id: row.id, name: row.name || row.id })),
        payouts_pagination: payoutPages,
        payouts: (payouts.results || []).map(row => {
            const currency = currencyCode(row.currency);
            return { reference: reference('PAY', row.id), amount_cents: row.amount_cents,
                currency, currency_decimals: currencyDecimals(currency), status: row.status,
                created_at: row.created_at, paid_at: row.paid_at, conversions: row.conversions };
        }),
        totals: (totals.results || []).reduce((acc, row) => {
            acc[row.status] = { commission_cents: row.commission || 0, count: row.n };
            return acc;
        }, {} as Record<string, { commission_cents: number; count: number }>),
    });
}
