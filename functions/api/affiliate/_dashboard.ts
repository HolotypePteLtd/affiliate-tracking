import { affiliateSessionToken, readSession } from '../_affiliate-auth.ts';
import { currencyCode, currencyDecimals } from '../../../src/money.ts';
import type { AffiliateEnv, AffiliatesRow, ConversionsRow } from '../../../src/types.ts';

export type SignedInAffiliate = Pick<AffiliatesRow, 'id' | 'code' | 'name' | 'email' | 'commission_pct' | 'status' | 'stripe_account_id'>;

export async function signedInAffiliate(request: Request, env: AffiliateEnv) {
    if (!env.DB || !env.AFFILIATE_SESSION_SECRET) {
        return Response.json({ error: 'Affiliate login is not configured' }, { status: 503 });
    }
    const token = affiliateSessionToken(request);
    const claims = token ? await readSession(token, env.AFFILIATE_SESSION_SECRET) : null;
    const affiliate = claims ? await env.DB.prepare(
        "SELECT id, code, name, email, commission_pct, status, stripe_account_id FROM affiliates WHERE id=?1 AND status='active' AND session_version=?2"
    ).bind(claims.sub, claims.version).first<SignedInAffiliate>() : null;
    return affiliate ? affiliate
        : Response.json({ error: 'unauthorized' }, { status: 401 });
}

export function positiveInteger(params: URLSearchParams, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number | null {
    const value = params.get(name);
    if (value === null) return fallback;
    const number = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0 && number <= max ? number : null;
}

function dateBoundary(value: string | null): number | null {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
}

export function conversionFilter(params: URLSearchParams, affiliateId: number) {
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
    const bindings: (string | number)[] = [affiliateId];
    const condition = (sql: string, value: string | number) => {
        bindings.push(value);
        conditions.push(sql.replace('?', `?${bindings.length}`));
    };
    if (start !== null) condition('created_at >= ?', start);
    if (end !== null) condition('created_at < ?', end + 86400000);
    if (status) condition('status = ?', status);
    if (product) condition("EXISTS (SELECT 1 FROM json_each(conversions.items_json) item WHERE json_extract(item.value, '$.product_id')=?)", product);
    return { where: conditions.join(' AND '), bindings };
}

export function pagination(requestedPage: number, perPage: number, total: number) {
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    return { page: Math.min(requestedPage, totalPages), per_page: perPage, total, total_pages: totalPages };
}

export function reference(kind: string, id: number): string {
    return kind + '-' + String(id).padStart(6, '0');
}

export const CONVERSION_COLUMNS = 'id, status, amount_cents, commission_cents, currency, customer_country, commission_pct, items_json, created_at, approved_at, paid_at, payout_id';

export function publicConversion(row: ConversionsRow) {
    // Whitelist fields; customer email/address and Stripe identifiers stay private.
    const items = (JSON.parse(row.items_json || '[]') as Record<string, unknown>[]).map(item => ({
        product_id: item.product_id || null, name: item.name || null,
        variant: item.variant || null, quantity: item.quantity,
    }));
    const currency = currencyCode(row.currency);
    return {
        reference: reference('AF', row.id), status: row.status,
        amount_cents: row.amount_cents, commission_cents: row.commission_cents,
        currency, currency_decimals: currencyDecimals(currency),
        country: row.customer_country || null, commission_pct: row.commission_pct ?? null,
        items, created_at: row.created_at, approved_at: row.approved_at,
        paid_at: row.paid_at, payout_reference: row.payout_id ? reference('PAY', row.payout_id) : null,
    };
}
