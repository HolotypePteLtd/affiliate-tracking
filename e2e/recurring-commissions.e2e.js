// Renewal commissions against Stripe test mode, with a test clock: a monthly
// subscription renews 13 times; the affiliate is paid for the first 12 months,
// each renewal once, and a refund cancels only its own renewal.
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { database } from '../tests/unit/_db.js';
import { recordConversion, recordRefund } from '../src/webhook.js';
import { recordInvoicePayment, addMonths } from '../src/invoice.js';
import { stripe, advanceClock, haveStripe, STRIPE_KEY } from './stripe.js';

describe.skipIf(!haveStripe)('renewal commissions with a real Stripe subscription', () => {
    let sql, env;
    const start = Math.floor(Date.now() / 1000);
    let clock, product, subscription;
    const seen = new Set();

    // Hand every paid invoice to the webhook helper, as invoice.paid would.
    async function deliverPaidInvoices() {
        const { data } = await stripe(`invoices?subscription=${subscription.id}&status=paid&limit=100`);
        for (const invoice of data) {
            if (seen.has(invoice.id)) continue;
            seen.add(invoice.id);
            await recordInvoicePayment(invoice, { id: 'evt_' + invoice.id, created: invoice.status_transitions?.paid_at }, env);
        }
    }

    beforeAll(async () => {
        const db = database();
        sql = db.sql;
        env = { DB: db.DB, STRIPE_SECRET_KEY: STRIPE_KEY };
        sql.exec("INSERT INTO affiliates (id,email,code,status,commission_pct,created_at) VALUES (1,'e2e@example.test','e2e','active',20,0)");
        product = await stripe('products', { name: 'cf-affiliate e2e monthly plan' });
        const price = await stripe('prices', { product: product.id, currency: 'usd', unit_amount: '2000', 'recurring[interval]': 'month' });
        clock = await stripe('test_helpers/test_clocks', { frozen_time: String(start), name: 'cf-affiliate e2e renewals' });
        const customer = await stripe('customers', {
            email: 'buyer@example.test', test_clock: clock.id,
            payment_method: 'pm_card_visa', 'invoice_settings[default_payment_method]': 'pm_card_visa',
        });
        subscription = await stripe('subscriptions', { customer: customer.id, 'items[0][price]': price.id });
        const first = await stripe(`invoices/${subscription.latest_invoice}`);
        assert.equal(first.status, 'paid');
        seen.add(first.id);
        // The Checkout sale that starts the subscription, with the real ids.
        await recordConversion({
            id: 'cs_e2e_' + subscription.id, mode: 'subscription', amount_total: first.amount_paid, currency: first.currency,
            customer: customer.id, subscription: subscription.id, invoice: first.id,
            customer_details: { email: 'buyer@example.test' },
            metadata: { affiliate_id: '1' }, discounts: [], total_details: { amount_discount: 0 },
        }, { id: 'evt_e2e_checkout', created: start }, env);
        // Its invoice.paid arrives too and must not pay twice.
        await recordInvoicePayment(first, { id: 'evt_' + first.id }, env);
    });

    afterAll(async () => {
        if (clock) await stripe(`test_helpers/test_clocks/${clock.id}`, undefined, 'DELETE').catch(() => {});
        if (product) await stripe(`products/${product.id}`, { active: 'false' }).catch(() => {});
        sql?.close();
    });

    it('pays 20% of each renewal for 12 months after the first sale, then stops', async () => {
        for (let month = 1; month <= 13; month++) {
            // Past the renewal and the hour a subscription invoice stays draft.
            await advanceClock(clock.id, Math.floor(addMonths(start * 1000, month) / 1000) + 2 * 3600);
            await deliverPaidInvoices();
        }
        const rows = sql.prepare('SELECT kind, amount_cents, commission_cents, payment_intent, status FROM conversions ORDER BY id').all();
        assert.equal(seen.size, 14, 'Stripe should have paid the first invoice and 13 renewals');
        assert.equal(rows.length, 12, 'the first sale and 11 renewals, all within 12 months');
        assert.equal(rows[0].kind, 'checkout');
        assert.ok(rows.slice(1).every(row => row.kind === 'renewal'));
        assert.ok(rows.every(row => row.amount_cents === 2000 && row.commission_cents === 400 && row.status === 'pending'));
        // Payment intents come from Stripe itself (invoice_payments on newer API versions).
        assert.ok(rows.every(row => typeof row.payment_intent === 'string' && row.payment_intent.startsWith('pi_')));
    });

    it('records nothing twice when Stripe resends invoice.paid', async () => {
        const before = sql.prepare('SELECT COUNT(*) AS n FROM conversions').get().n;
        const { data } = await stripe(`invoices?subscription=${subscription.id}&status=paid&limit=100`);
        for (const invoice of data) await recordInvoicePayment(invoice, { id: 'evt_again_' + invoice.id }, env);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM conversions').get().n, before);
    });

    it('a real refund of one renewal cancels only that renewal', async () => {
        const target = sql.prepare("SELECT stripe_invoice_id, payment_intent FROM conversions WHERE kind='renewal' ORDER BY id LIMIT 1 OFFSET 1").get();
        const refund = await stripe('refunds', { payment_intent: target.payment_intent });
        const charge = await stripe(`charges/${refund.charge}`);
        await recordRefund({ id: 'evt_refund', type: 'charge.refunded', data: { object: charge } }, env);
        const statuses = sql.prepare('SELECT stripe_invoice_id, status FROM conversions ORDER BY id').all();
        assert.deepEqual(statuses.filter(row => row.status === 'refunded').map(row => row.stripe_invoice_id), [target.stripe_invoice_id]);
    });
});
