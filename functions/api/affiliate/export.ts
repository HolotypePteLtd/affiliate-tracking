import { signedInAffiliate, conversionFilter, CONVERSION_COLUMNS, publicConversion } from './_dashboard.ts';
import type { AffiliateRouteContext, ConversionsRow } from '../../../src/types.ts';

function csvCell(value: unknown) {
    let text = value == null ? '' : String(value);
    // Prevent product/variant strings from becoming spreadsheet formulas.
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}

const csvLine = (values: unknown[]) => values.map(csvCell).join(',') + '\r\n';
const date = (value: number | null) => value == null ? '' : new Date(value).toISOString();
const amount = (value: number, decimals: number | null) => decimals == null ? '' : (value / 10 ** decimals).toFixed(decimals);

export async function onRequestGet(context: AffiliateRouteContext) {
    const affiliate = await signedInAffiliate(context.request, context.env);
    if (affiliate instanceof Response) return affiliate;
    const db = context.env.DB;
    if (!db) return Response.json({ error: 'Affiliate login is not configured' }, { status: 503 });
    const filter = conversionFilter(new URL(context.request.url).searchParams, affiliate.id);
    if (filter instanceof Response) return filter;
    const encoder = new TextEncoder();
    let cursor: { created_at: number; id: number } | null = null;
    let cancelled = false;
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(csvLine(['Order reference', 'Date (UTC)', 'Product', 'Variant', 'Quantity',
                'Billing country', 'Currency', 'Currency decimals', 'Sale', 'Sale (minor units)',
                'Commission', 'Commission (minor units)', 'Commission %', 'Status',
                'Approved (UTC)', 'Paid (UTC)', 'Payout reference'])));
        },
        async pull(controller) {
            try {
                const bindings = [...filter.bindings];
                let where = filter.where;
                if (cursor) {
                    bindings.push(cursor.created_at, cursor.id);
                    where += ` AND (created_at < ?${bindings.length - 1} OR (created_at = ?${bindings.length - 1} AND id < ?${bindings.length}))`;
                }
                const rows = (await db.prepare(
                    `SELECT ${CONVERSION_COLUMNS} FROM conversions WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 200`
                ).bind(...bindings).all<ConversionsRow>()).results || [];
                if (cancelled) return;
                const output = rows.map(row => {
                    const c = publicConversion(row);
                    return csvLine([c.reference, date(c.created_at), c.items.map(item => item.name || 'Unknown product').join('; '),
                        c.items.map(item => item.variant || '').join('; '), c.items.map(item => item.quantity).join('; '),
                        c.country, c.currency?.toUpperCase(), c.currency_decimals,
                        amount(c.amount_cents, c.currency_decimals), c.amount_cents,
                        amount(c.commission_cents, c.currency_decimals), c.commission_cents,
                        c.commission_pct, c.status, date(c.approved_at), date(c.paid_at), c.payout_reference]);
                }).join('');
                if (output) controller.enqueue(encoder.encode(output));
                if (rows.length < 200) controller.close();
                else cursor = rows[rows.length - 1];
            } catch (error: unknown) {
                if (!cancelled) controller.error(error);
            }
        },
        cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="affiliate-conversions.csv"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    } });
}
