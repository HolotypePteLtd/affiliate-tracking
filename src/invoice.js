// Recurring commissions.
//
// Subscribe your webhook to invoice.paid and call this in its verified branch,
// awaiting it before acknowledging Stripe:
//
//   if (event.type === 'invoice.paid') await recordInvoicePayment(event.data.object, event, env);
//
// A renewal pays the affiliate who got the subscription's first sale (the
// Checkout conversion recordConversion stored), at that affiliate's rate, for
// recurring_months months after the first sale. The first invoice of a new
// subscription is skipped: its Checkout session is the sale. Idempotent by
// invoice id. Refunds and disputes of a renewal cancel only that renewal,
// through recordRefund as before.

import { currencyCode } from './money.js';
import { stripeId, stripeRequest } from './stripe.js';

export const DEFAULT_RECURRING_MONTHS = 12;

export function recurringMonths(affiliate, env) {
    if (Number.isSafeInteger(affiliate?.recurring_months) && affiliate.recurring_months >= 0) return affiliate.recurring_months;
    const raw = env?.AFFILIATE_RECURRING_MONTHS;
    if (raw === undefined || raw === null || raw === '') return DEFAULT_RECURRING_MONTHS;
    const months = Number(raw);
    if (!Number.isSafeInteger(months) || months < 0 || months > 1200) {
        throw new Error('AFFILIATE_RECURRING_MONTHS must be a whole number of months from 0 to 1200');
    }
    return months;
}

// The same day N calendar months later (clamped to the month's last day).
export function addMonths(timestamp, months) {
    const date = new Date(timestamp);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    return date.getTime();
}

// Stripe moved these fields in API version 2025-03-31.basil; read both shapes.
export function invoiceSubscription(invoice) {
    return stripeId(invoice?.subscription) || stripeId(invoice?.parent?.subscription_details?.subscription);
}

export async function invoicePaymentIntent(invoice, env) {
    const direct = stripeId(invoice?.payment_intent);
    if (direct) return direct;
    for (const row of invoice?.payments?.data || []) {
        const id = stripeId(row?.payment?.payment_intent);
        if (id) return id;
    }
    if (!invoice?.id || !env.STRIPE_SECRET_KEY) return null;
    const payments = await stripeRequest(env, `invoice_payments?invoice=${encodeURIComponent(invoice.id)}&limit=10`);
    for (const row of payments?.data || []) {
        const id = stripeId(row?.payment?.payment_intent);
        if (id) return id;
    }
    return null;
}

export async function recordInvoicePayment(invoice, event, env) {
    if (!invoice?.id || invoice.object && invoice.object !== 'invoice') return null;
    if (!env.DB) throw new Error('Affiliate DB is not configured');
    // The subscription's first invoice is the Checkout sale itself.
    if (invoice.billing_reason === 'subscription_create') return null;
    const amount = Number.isFinite(invoice.amount_paid) ? invoice.amount_paid : 0;
    if (amount <= 0) return null;

    const existing = await env.DB.prepare('SELECT id FROM conversions WHERE stripe_invoice_id=?1').bind(invoice.id).first();
    if (existing) return null;

    const subscription = invoiceSubscription(invoice);
    const customer = stripeId(invoice.customer);
    if (!subscription && !customer) return null;
    // The sale that started it: the subscription's Checkout conversion, or
    // failing that the customer's first attributed one.
    const first = await env.DB.prepare(`
        SELECT c.affiliate_id, c.created_at, a.commission_pct, a.status, a.recurring_months
        FROM conversions c JOIN affiliates a ON a.id=c.affiliate_id
        WHERE c.kind='checkout' AND (
            (?1 IS NOT NULL AND c.stripe_subscription_id=?1) OR
            (?2 IS NOT NULL AND c.stripe_customer_id=?2))
        ORDER BY CASE WHEN c.stripe_subscription_id=?1 THEN 0 ELSE 1 END, c.created_at, c.id
        LIMIT 1`).bind(subscription, customer).first();
    if (!first || first.status !== 'active') return null;

    const paidAt = Number.isFinite(invoice.status_transitions?.paid_at) ? invoice.status_transitions.paid_at * 1000
        : Number.isFinite(event?.created) ? event.created * 1000 : Date.now();
    const months = recurringMonths(first, env);
    if (paidAt >= addMonths(first.created_at, months)) return null;

    const paymentIntent = await invoicePaymentIntent(invoice, env);
    const items = (invoice.lines?.data || []).map(line => {
        const product = line.price?.product ?? line.pricing?.price_details?.product;
        return {
            product_id: typeof product === 'string' ? product : product?.id || null,
            name: line.description || product?.name || null,
            variant: line.price?.nickname || null,
            quantity: line.quantity || 1,
        };
    });
    const country = invoice.customer_address?.country;
    const commission = Math.round(amount * first.commission_pct / 100);
    const result = await env.DB.prepare(`
        INSERT INTO conversions
          (affiliate_id, stripe_session_id, stripe_event_id, payment_intent, customer_email,
           amount_cents, commission_cents, status, created_at, currency, customer_country,
           commission_pct, items_json, stripe_customer_id, stripe_subscription_id, stripe_invoice_id, kind)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                CASE WHEN ?4 IS NOT NULL AND EXISTS (SELECT 1 FROM refunded_payments WHERE payment_intent=?4)
                     THEN 'refunded' ELSE 'pending' END,
                ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?2, 'renewal')
        ON CONFLICT DO NOTHING`).bind(
        first.affiliate_id, invoice.id, event?.id || null, paymentIntent, invoice.customer_email || null,
        amount, commission, paidAt, currencyCode(invoice.currency),
        typeof country === 'string' && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : null,
        first.commission_pct, JSON.stringify(items), customer, subscription,
    ).run();
    return result.meta?.changes ? { affiliate_id: first.affiliate_id, commission_cents: commission } : null;
}
