//   GET /api/affiliate/stats?days=30
//     The signed-in affiliate's funnel and click charts for the last N days.

import { signedInAffiliate } from './_dashboard.js';
import { affiliateStats, statsRange, MAX_DAYS } from '../../../src/analytics.js';

export async function onRequestGet({ request, env }) {
    const aff = await signedInAffiliate(request, env);
    if (aff instanceof Response) return aff;
    const range = statsRange(new URL(request.url).searchParams);
    if (!range) return Response.json({ error: `days must be a whole number from 1 to ${MAX_DAYS}` }, { status: 400 });
    const stats = await affiliateStats(env, { affiliateId: aff.id, range });
    return Response.json({ ...stats, funnel: stats.funnel[0] || null });
}
