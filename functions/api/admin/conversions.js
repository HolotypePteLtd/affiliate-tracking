//   GET /api/admin/conversions?status=pending
//     Lists conversions, filterable by status. Returns affiliate code/name
//     alongside each row.

import { requireAdmin } from './_gate.js';

export async function onRequestGet(context) {
    const gate = requireAdmin(context.env, context.request);
    if (gate) return gate;

    const db = context.env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });

    const status = new URL(context.request.url).searchParams.get('status') || null;

    let rows;
    if (status) {
        rows = await db.prepare(`
            SELECT cnv.id, cnv.affiliate_id, a.code as affiliate_code, a.name as affiliate_name,
                   cnv.stripe_session_id, cnv.customer_email, cnv.amount_cents,
                   cnv.commission_cents, cnv.status, cnv.created_at
            FROM conversions cnv
            JOIN affiliates a ON a.id = cnv.affiliate_id
            WHERE cnv.status=?1
            ORDER BY cnv.created_at DESC LIMIT 200
        `).bind(status).all();
    } else {
        rows = await db.prepare(`
            SELECT cnv.id, cnv.affiliate_id, a.code as affiliate_code, a.name as affiliate_name,
                   cnv.stripe_session_id, cnv.customer_email, cnv.amount_cents,
                   cnv.commission_cents, cnv.status, cnv.created_at
            FROM conversions cnv
            JOIN affiliates a ON a.id = cnv.affiliate_id
            ORDER BY cnv.created_at DESC LIMIT 200
        `).all();
    }

    return Response.json({ ok: true, conversions: rows.results || [] });
}
