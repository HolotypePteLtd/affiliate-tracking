// Automatic hold period.
//
// Call from your Worker's scheduled() handler (a daily cron is enough):
//
//   async scheduled(event, env, ctx) {
//       ctx.waitUntil(releaseHeldConversions(env));
//   }
//
// With AFFILIATE_HOLD_DAYS unset, nothing is released and every conversion
// waits for manual approval, as before. With it set, a pending conversion is
// approved once it is at least that many days old, unless it was refunded or
// disputed, its affiliate is not active, the affiliate has review_required,
// or the sale was flagged by the fraud checks (src/fraud.js).

const DAY_MS = 24 * 60 * 60 * 1000;

export function holdDays(env) {
    const raw = env?.AFFILIATE_HOLD_DAYS;
    if (raw === undefined || raw === null || raw === '') return null;
    const days = Number(raw);
    if (!Number.isSafeInteger(days) || days < 0 || days > 3650) {
        throw new Error('AFFILIATE_HOLD_DAYS must be a whole number of days from 0 to 3650');
    }
    return days;
}

export async function releaseHeldConversions(env, now = Date.now()) {
    const days = holdDays(env);
    if (days === null) return 0;
    if (!env.DB) throw new Error('Affiliate DB is not configured');
    const cutoff = now - days * DAY_MS;
    const result = await env.DB.prepare(`
        UPDATE conversions SET status='approved', approved_at=?1
        WHERE status='pending' AND created_at <= ?2 AND fraud_reason IS NULL
          AND affiliate_id IN (SELECT id FROM affiliates WHERE status='active' AND review_required=0)
          AND (payment_intent IS NULL
               OR NOT EXISTS (SELECT 1 FROM refunded_payments r WHERE r.payment_intent=conversions.payment_intent))
    `).bind(now, cutoff).run();
    return result.meta?.changes || 0;
}
