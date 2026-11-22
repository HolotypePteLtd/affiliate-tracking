import { requireAdmin } from './_gate.ts';
import type { AffiliateRouteContext } from '../../../src/types.ts';

export async function onRequestGet({ request, env }: AffiliateRouteContext) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const rows = await env.DB.prepare(`
        SELECT p.id, p.affiliate_id, a.code AS affiliate_code, a.name AS affiliate_name,
               p.amount_cents, p.currency, p.status, p.stripe_transfer_id, p.created_at
        FROM payouts p JOIN affiliates a ON a.id=p.affiliate_id
        ORDER BY p.created_at DESC LIMIT 200
    `).all();
    return Response.json({ ok: true, payouts: rows.results || [] });
}
