import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { recordConversion, recordRefund } from '../../src/webhook.js';
import { recordInvoicePayment, addMonths } from '../../src/invoice.js';
import { database } from './_db.js';

const cleanups = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; for (const fn of cleanups.splice(0).reverse()) fn(); });

const START = Date.parse('2026-01-31T10:00:00Z');
const seconds = ms => Math.floor(ms / 1000);

function setup(affiliate = "(1,'nick@example.test','nick','active',20,NULL,0)") {
    const { sql, DB } = database();
    cleanups.push(() => sql.close());
    sql.exec(`INSERT INTO affiliates (id,email,code,status,commission_pct,recurring_months,created_at) VALUES ${affiliate}`);
    const env = { DB };
    const rows = () => sql.prepare('SELECT kind, stripe_session_id, commission_cents, status, payment_intent FROM conversions ORDER BY id').all().map(r => ({ ...r }));
    return { sql, env, rows };
}

// The Checkout session that starts a subscription (no payment intent of its own).
function subscribe(env, { subscription = 'sub_1', customer = 'cus_1' } = {}) {
    return recordConversion({ id: 'cs_sub', mode: 'subscription', amount_total: 2000, currency: 'usd',
        customer, subscription, invoice: 'in_first', metadata: { affiliate_id: '1' }, discounts: [], total_details: { amount_discount: 0 } },
        { id: 'evt_cs', created: seconds(START) }, env);
}

function invoice(n, overrides = {}) {
    const paidAt = addMonths(START, n);
    return {
        id: 'in_' + n, object: 'invoice', billing_reason: 'subscription_cycle', amount_paid: 2000, currency: 'usd',
        customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } },
        payment_intent: 'pi_' + n, status_transitions: { paid_at: seconds(paidAt) },
        lines: { data: [{ description: 'Pro plan', quantity: 1, price: { product: 'prod_pro', nickname: 'Monthly' } }] },
        ...overrides,
    };
}

describe('recurring commissions', () => {
    it('pays each renewal for 12 months after the first sale, then stops', async () => {
        const { env, rows } = setup();
        await subscribe(env);
        // The first invoice belongs to the Checkout sale and is not paid twice.
        assert.equal(await recordInvoicePayment(invoice(0, { id: 'in_first', billing_reason: 'subscription_create' }), {}, env), null);
        for (let n = 1; n <= 13; n++) await recordInvoicePayment(invoice(n), { id: 'evt_in_' + n }, env);
        const all = rows();
        assert.equal(all.filter(r => r.kind === 'checkout').length, 1);
        const renewals = all.filter(r => r.kind === 'renewal');
        assert.deepEqual(renewals.map(r => r.stripe_session_id), Array.from({ length: 11 }, (_, i) => 'in_' + (i + 1)));
        assert.ok(renewals.every(r => r.commission_cents === 400 && r.status === 'pending'));
        // 12 paid months in all: the Checkout sale plus 11 renewals.
        assert.equal(all.length, 12);
    });

    it('is idempotent by invoice, including a resent event', async () => {
        const { env, rows } = setup();
        await subscribe(env);
        assert.ok(await recordInvoicePayment(invoice(1), { id: 'evt_a' }, env));
        assert.equal(await recordInvoicePayment(invoice(1), { id: 'evt_a' }, env), null);
        assert.equal(await recordInvoicePayment(invoice(1), { id: 'evt_b' }, env), null);
        assert.equal(rows().length, 2);
    });

    it('uses the affiliate\'s own months, and 0 means first payment only', async () => {
        const three = setup("(1,'nick@example.test','nick','active',20,3,0)");
        await subscribe(three.env);
        for (let n = 1; n <= 5; n++) await recordInvoicePayment(invoice(n), {}, three.env);
        assert.equal(three.rows().filter(r => r.kind === 'renewal').length, 2);

        const none = setup("(1,'nick@example.test','nick','active',20,0,0)");
        await subscribe(none.env);
        assert.equal(await recordInvoicePayment(invoice(1), {}, none.env), null);

        const envDefault = setup();
        await subscribe(envDefault.env);
        envDefault.env.AFFILIATE_RECURRING_MONTHS = '2';
        for (let n = 1; n <= 3; n++) await recordInvoicePayment(invoice(n), {}, envDefault.env);
        assert.equal(envDefault.rows().filter(r => r.kind === 'renewal').length, 1);
    });

    it('a refund of one renewal cancels only that renewal', async () => {
        const { env, rows } = setup();
        await subscribe(env);
        await recordInvoicePayment(invoice(1), {}, env);
        await recordInvoicePayment(invoice(2), {}, env);
        await recordRefund({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_2' } } }, env);
        assert.deepEqual(rows().map(r => [r.stripe_session_id, r.status]),
            [['cs_sub', 'pending'], ['in_1', 'pending'], ['in_2', 'refunded']]);
        // A refund that arrives before its invoice.paid still applies.
        await recordRefund({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_3' } } }, env);
        await recordInvoicePayment(invoice(3), {}, env);
        assert.equal(rows().at(-1).status, 'refunded');
    });

    it('pays nothing for customers who weren\'t referred, suspended affiliates, or free invoices', async () => {
        const { sql, env, rows } = setup();
        assert.equal(await recordInvoicePayment(invoice(1), {}, env), null);
        await subscribe(env);
        assert.equal(await recordInvoicePayment(invoice(1, { amount_paid: 0 }), {}, env), null);
        sql.exec("UPDATE affiliates SET status='suspended'");
        assert.equal(await recordInvoicePayment(invoice(2), {}, env), null);
        assert.equal(rows().length, 1);
    });

    it('finds the payment intent with the newer Stripe API, where invoices no longer carry it', async () => {
        const { env, rows } = setup();
        env.STRIPE_SECRET_KEY = 'sk_test_unused';
        const asked = [];
        globalThis.fetch = async url => {
            asked.push(String(url));
            const { pathname, searchParams } = new URL(url);
            // Newer API versions: the invoice has no payment_intent, invoice_payments does.
            if (pathname.startsWith('/v1/invoices/')) return Response.json({ id: pathname.split('/').pop(), object: 'invoice' });
            return Response.json({ data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_for_' + searchParams.get('invoice') } }] });
        };
        await subscribe(env);
        await recordInvoicePayment(invoice(1, { payment_intent: undefined }), {}, env);
        assert.deepEqual(rows().map(r => r.payment_intent), ['pi_for_in_first', 'pi_for_in_1']);
        assert.deepEqual(asked.map(url => new URL(url).pathname), ['/v1/invoices/in_first', '/v1/invoice_payments', '/v1/invoice_payments']);
    });

    it('reads the payment intent from the invoice on API versions before 2025-03-31.basil', async () => {
        const { env, rows } = setup();
        env.STRIPE_SECRET_KEY = 'sk_test_unused';
        globalThis.fetch = async url => Response.json({ id: 'in_first', object: 'invoice', payment_intent: 'pi_old_shape' });
        await subscribe(env);
        assert.deepEqual(rows().map(r => r.payment_intent), ['pi_old_shape']);
    });

    it('adds calendar months the way a monthly subscription renews', () => {
        assert.equal(new Date(addMonths(Date.parse('2026-01-31T10:00:00Z'), 1)).toISOString(), '2026-02-28T10:00:00.000Z');
        assert.equal(new Date(addMonths(Date.parse('2026-01-15T00:00:00Z'), 12)).toISOString(), '2027-01-15T00:00:00.000Z');
    });
});
