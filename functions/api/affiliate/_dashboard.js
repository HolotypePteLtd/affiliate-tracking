import { affiliateSessionToken, readSession } from '../_affiliate-auth.js';
import { currencyCode, currencyDecimals } from '../../../src/money.js';

export async function signedInAffiliate(request, env) {
    if (!env.DB || !env.AFFILIATE_SESSION_SECRET) {
        return Response.json({ error: 'Affiliate login is not configured' }, { status: 503 });
    }
    const claims = await readSession(affiliateSessionToken(request), env.AFFILIATE_SESSION_SECRET);
    const affiliate = claims ? await env.DB.prepare(
        "SELECT id, code, name, email, commission_pct, status, stripe_account_id FROM affiliates WHERE id=?1 AND status='active' AND session_version=?2"
    ).bind(claims.sub, claims.version).first() : null;
    return affiliate ? affiliate
        : Response.json({ error: 'unauthorized' }, { status: 401 });
}

export function positiveInteger(params, name, fallback, max = Number.MAX_SAFE_INTEGER) {
    const value = params.get(name);
    if (value === null) return fallback;
    const number = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0 && number <= max ? number : null;
}

function dateBoundary(value) {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
}

export function conversionFilter(params, affiliateId) {
    const start = dateBoundary(params.get('start_date'));
    const end = dateBoundary(params.get('end_date'));
    const status = params.get('status') || '';
    const product = params.get('product') || '';
    if (Number.isNaN(start) || Number.isNaN(end) || (start !== null && end !== null && start > end) ||
        (status && !['pending', 'approved', 'paying', 'paid', 'refunded'].includes(status)) ||
        product.length > 200 || /[\x00-\x1f]/.test(product)) {
        return Response.json({ error: 'Invalid conversion filters' }, { status: 400 });
    }
    const conditions = ['affiliate_id=?1'];
    const bindings = [affiliateId];
    const condition = (sql, value) => {
        bindings.push(value);
        conditions.push(sql.replace('?', `?${bindings.length}`));
    };
    if (start !== null) condition('created_at >= ?', start);
    if (end !== null) condition('created_at < ?', end + 86400000);
    if (status) condition('status = ?', status);
    if (product) condition("EXISTS (SELECT 1 FROM json_each(conversions.items_json) item WHERE json_extract(item.value, '$.product_id')=?)", product);
    return { where: conditions.join(' AND '), bindings };
}

export function pagination(requestedPage, perPage, total) {
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    return { page: Math.min(requestedPage, totalPages), per_page: perPage, total, total_pages: totalPages };
}

export function reference(kind, id) {
    return kind + '-' + String(id).padStart(6, '0');
}

export const CONVERSION_COLUMNS = 'id, status, kind, amount_cents, commission_cents, currency, customer_country, commission_pct, items_json, created_at, approved_at, paid_at, payout_id';

export function publicConversion(row) {
    // Whitelist fields; customer email/address and Stripe identifiers stay private.
    const items = JSON.parse(row.items_json || '[]').map(item => ({
        product_id: item.product_id || null, name: item.name || null,
        variant: item.variant || null, quantity: item.quantity,
    }));
    const currency = currencyCode(row.currency);
    return {
        reference: reference('AF', row.id), status: row.status, kind: row.kind || 'checkout',
        amount_cents: row.amount_cents, commission_cents: row.commission_cents,
        currency, currency_decimals: currencyDecimals(currency),
        country: row.customer_country || null, commission_pct: row.commission_pct ?? null,
        items, created_at: row.created_at, approved_at: row.approved_at,
        paid_at: row.paid_at, payout_reference: row.payout_id ? reference('PAY', row.payout_id) : null,
    };
}
