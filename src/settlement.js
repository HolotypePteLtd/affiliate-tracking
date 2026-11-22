// Commission amounts in the payout currency.
//
// Payouts are Stripe transfers from the platform balance, which is held in the
// platform's settlement currency (AFFILIATE_PAYOUT_CURRENCY, default usd).
// A sale in another currency was already converted by Stripe when it settled;
// its balance transaction records both amounts. The commission is converted
// in the same proportion, so the affiliate is paid at Stripe's own rate for
// that sale, and conversions.fx_source keeps the balance transaction id.

import { currencyCode } from './money.js';
import { stripeRequest } from './stripe.js';

export function payoutCurrency(env) {
    const code = currencyCode(env?.AFFILIATE_PAYOUT_CURRENCY || 'usd');
    if (!code) throw new Error('AFFILIATE_PAYOUT_CURRENCY must be a three-letter currency code');
    return code;
}

// Commission in the payout currency, from the sale's settled charge.
export async function convertedCommission(env, { payment_intent: paymentIntent, currency, commission_cents: commission }, target) {
    if (!paymentIntent || !env.STRIPE_SECRET_KEY) return null;
    const intent = await stripeRequest(env,
        `payment_intents/${encodeURIComponent(paymentIntent)}?expand[]=latest_charge.balance_transaction`);
    const charge = intent.latest_charge;
    const txn = charge?.balance_transaction;
    if (!charge || typeof txn !== 'object' || !txn) return null;
    if (currencyCode(charge.currency) !== currency || currencyCode(txn.currency) !== target) return null;
    if (!Number.isSafeInteger(charge.amount) || charge.amount <= 0 || !Number.isSafeInteger(txn.amount) || txn.amount <= 0) return null;
    return { cents: Math.round(commission * txn.amount / charge.amount), source: txn.id };
}

// Fill payout_cents for approved, unpaid commissions that don't have it yet.
// Same-currency commissions are copied; others are converted through Stripe.
// Ones that can't be converted stay NULL and need reconciliation.
export async function settleApprovedCommissions(env, affiliateId = null) {
    const db = env.DB;
    const target = payoutCurrency(env);
    const now = Date.now();
    await db.prepare(`UPDATE conversions SET payout_currency=?1, payout_cents=commission_cents, fx_checked_at=?2
        WHERE status='approved' AND payout_id IS NULL AND payout_cents IS NULL AND currency=?1
          AND (?3 IS NULL OR affiliate_id=?3)`).bind(target, now, affiliateId).run();
    const { results } = await db.prepare(`SELECT id, payment_intent, currency, commission_cents FROM conversions
        WHERE status='approved' AND payout_id IS NULL AND payout_cents IS NULL
          AND currency IS NOT NULL AND currency!=?1 AND (?2 IS NULL OR affiliate_id=?2)
        LIMIT 100`).bind(target, affiliateId).all();
    for (const row of results || []) {
        let converted = null;
        try {
            converted = await convertedCommission(env, row, target);
        } catch (err) {
            console.error(`Commission ${row.id} could not be converted:`, err.message);
        }
        if (!converted) continue;
        await db.prepare(`UPDATE conversions SET payout_currency=?1, payout_cents=?2, fx_source=?3, fx_checked_at=?4
            WHERE id=?5 AND payout_cents IS NULL`).bind(target, converted.cents, converted.source, now, row.id).run();
    }
}
