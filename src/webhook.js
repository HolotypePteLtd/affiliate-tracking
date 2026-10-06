// Webhook conversion recording.
//
// Call from your checkout.session.completed / async_payment_succeeded handler
// once payment is confirmed. Idempotent (UNIQUE stripe_session_id +
// ON CONFLICT DO NOTHING) and best-effort: logs rather than throws, because a
// failed affiliate insert must never fail a Stripe webhook.
//
//   ctx.waitUntil(recordConversion(session, event, env));

export async function recordConversion(session, event, env) {
    try {
        if (!session || !env.DB) return;
        const affiliateId = session.metadata?.affiliate_id;
        if (!affiliateId) return;

        const aff = await env.DB.prepare(
            'SELECT commission_pct FROM affiliates WHERE id=?1'
        ).bind(affiliateId).first();
        if (!aff) return;

        const commission = Math.round(
            (session.amount_total || 0) * aff.commission_pct / 100
        );
        await env.DB.prepare(`
            INSERT INTO conversions
              (affiliate_id, stripe_session_id, stripe_event_id, payment_intent,
               customer_email, amount_cents, commission_cents, status, created_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)
            ON CONFLICT(stripe_session_id) DO NOTHING
        `).bind(
            affiliateId,
            session.id,
            event?.id || null,
            session.payment_intent || null,
            session.customer_details?.email || null,
            session.amount_total,
            commission,
            Date.now()
        ).run();
    } catch (err) {
        console.error('Affiliate conversion insert failed:', err.message);
    }
}
