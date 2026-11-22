// Idempotent conversion recording. Database failures propagate to the webhook
// so it returns non-2xx and Stripe retries instead of losing the commission.

import { currencyCode } from './money.js';
import { resolvePaidAttribution } from './promotion.js';
import { stripeId, stripeRequest } from './stripe.js';
import { invoicePaymentIntent } from './invoice.js';

export async function recordConversion(session, event, env, lineItems = session?.line_items?.data || []) {
    if (!session) return null;
    // Resolve before the first insert: idempotent retries preserve the original
    // affiliate and money, so a provisional cookie attribution must never win.
    const candidate = session.metadata?.affiliate_id || session.metadata?.affiliate_attribution_version ||
        session.discounts?.length || session.allow_promotion_codes;
    const recorded = candidate && env.DB ? await env.DB.prepare(
        `SELECT c.affiliate_id, a.code AS affiliate_code FROM conversions c
         LEFT JOIN affiliates a ON a.id=c.affiliate_id WHERE c.stripe_session_id=?1`
    ).bind(session.id).first() : null;
    if (recorded) {
        // Preserve and enrich an already verified purchase even if a code is
        // replaced or an affiliate is suspended before a delayed retry.
        const metadata = { ...session.metadata, affiliate_id: String(recorded.affiliate_id), affiliate_source: 'recorded' };
        delete metadata.affiliate_code;
        if (recorded.affiliate_code) metadata.affiliate_code = recorded.affiliate_code;
        session = { ...session, metadata };
    } else {
        session = await resolvePaidAttribution(session, env);
    }
    if (!session.metadata?.affiliate_id) return null;
    if (!env.DB) throw new Error('Affiliate DB is not configured');
    const affiliateId = session.metadata?.affiliate_id;
    if (!affiliateId) return;

    const aff = await env.DB.prepare(
        'SELECT commission_pct, status FROM affiliates WHERE id=?1'
    ).bind(affiliateId).first();
    if (!aff) throw new Error('Attributed affiliate not found');
    if (!recorded && aff.status !== 'active') return null;

    const amountTotal = Number.isFinite(session.amount_total) ? session.amount_total : 0;
    const commission = Math.round(
        amountTotal * aff.commission_pct / 100
    );
    const country = session.customer_details?.address?.country;
    const itemsList = Array.isArray(lineItems) ? lineItems : [];
    const items = itemsList.map(item => {
        const product = item.price?.product;
        return {
            product_id: typeof product === 'string' ? product : product?.id || null,
            name: item.description || product?.name || null,
            variant: item.price?.nickname || null,
            quantity: item.quantity || 1,
        };
    });
    // A subscription Checkout has no payment intent of its own; its first
    // invoice's payment is the one a refund or dispute will name.
    const invoiceId = stripeId(session.invoice);
    const paymentIntent = stripeId(session.payment_intent) ||
        (invoiceId && env.STRIPE_SECRET_KEY ? await invoicePaymentIntent({ id: invoiceId }, env) : null);
    await env.DB.prepare(`
        INSERT INTO conversions
          (affiliate_id, stripe_session_id, stripe_event_id, payment_intent,
           customer_email, amount_cents, commission_cents, status, created_at,
           currency, customer_country, commission_pct, items_json,
           stripe_customer_id, stripe_subscription_id, stripe_invoice_id)
        VALUES (?1,?2,?3,?4,?5,?6,?7,
                CASE WHEN EXISTS (SELECT 1 FROM refunded_payments WHERE payment_intent=?4)
                     THEN 'refunded' ELSE 'pending' END,?8,?9,?10,?11,?12,?13,?14,?15)
        ON CONFLICT(stripe_session_id) DO UPDATE SET
          payment_intent=COALESCE(conversions.payment_intent, excluded.payment_intent),
          status=CASE WHEN excluded.status='refunded' AND conversions.status IN ('pending','approved','paying')
                         AND (conversions.payment_intent IS NULL OR conversions.payment_intent=excluded.payment_intent)
                      THEN 'refunded' ELSE conversions.status END,
          currency=COALESCE(conversions.currency, excluded.currency),
          stripe_customer_id=COALESCE(conversions.stripe_customer_id, excluded.stripe_customer_id),
          stripe_subscription_id=COALESCE(conversions.stripe_subscription_id, excluded.stripe_subscription_id),
          stripe_invoice_id=COALESCE(conversions.stripe_invoice_id, excluded.stripe_invoice_id),
          customer_country=COALESCE(conversions.customer_country, excluded.customer_country),
          items_json=CASE WHEN conversions.items_json='[]' THEN excluded.items_json ELSE conversions.items_json END
    `).bind(
        affiliateId,
        session.id,
        event?.id || null,
        paymentIntent,
        session.customer_details?.email || null,
        amountTotal,
        commission,
        Number.isFinite(event?.created) ? event.created * 1000 : Date.now(),
        currencyCode(session.currency),
        typeof country === 'string' && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : null,
        aff.commission_pct,
        JSON.stringify(items),
        stripeId(session.customer),
        stripeId(session.subscription),
        invoiceId
    ).run();
    return session;
}

// Call after verifying the Stripe signature. Keep a marker even if Checkout
// hasn't arrived, and preserve the history of commissions already paid.
export async function recordRefund(event, env) {
    if (event?.type !== 'charge.refunded' && event?.type !== 'charge.dispute.created') return 0;
    const object = event.data?.object;
    let paymentIntent = stripeId(object?.payment_intent ?? object?.charge?.payment_intent);
    if (!paymentIntent && event.type === 'charge.dispute.created' && typeof object?.charge === 'string') {
        const charge = await stripeRequest(env, `charges/${encodeURIComponent(object.charge)}`);
        paymentIntent = stripeId(charge.payment_intent);
    }
    if (!paymentIntent) return 0;
    if (!env.DB) throw new Error('Affiliate DB is not configured');
    const [, updated] = await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO refunded_payments (payment_intent) VALUES (?1)').bind(paymentIntent),
        env.DB.prepare(`UPDATE conversions SET status='refunded'
            WHERE payment_intent=?1 AND status IN ('pending','approved','paying')`).bind(paymentIntent),
    ]);
    return updated.meta.changes;
}
