//   GET /api/admin/stats?days=30&affiliate_id=1
//     The funnel per affiliate and the click charts, for everyone or one affiliate.

import { requireAdmin } from './_gate.js';
import { affiliateStats, statsRange, MAX_DAYS } from '../../../src/analytics.js';

export async function onRequestGet({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const params = new URL(request.url).searchParams;
    const range = statsRange(params);
    if (!range) return Response.json({ ok: false, error: `days must be a whole number from 1 to ${MAX_DAYS}` }, { status: 400 });
    const raw = params.get('affiliate_id');
    const affiliateId = raw === null ? null : Number(raw);
    if (affiliateId !== null && (!Number.isSafeInteger(affiliateId) || affiliateId <= 0)) {
        return Response.json({ ok: false, error: 'affiliate_id must be an affiliate id' }, { status: 400 });
    }
    return Response.json({ ok: true, ...await affiliateStats(env, { affiliateId, range }) });
}
