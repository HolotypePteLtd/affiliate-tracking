// Commission on a sale in another currency, converted at the rate Stripe
// really used: a test-mode card payment in a foreign currency settles into the
// platform balance, and a payout run reads that balance transaction.
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { database, context } from '../tests/unit/_db.js';
import { onRequestPost as runPayouts } from '../functions/api/admin/payouts-run.js';
import { stripe, haveStripe, STRIPE_KEY } from './stripe.js';

describe.skipIf(!haveStripe)('payout currency with a real Stripe payment', () => {
    let sql, env, payoutCurrency, saleCurrency, intent;

    beforeAll(async () => {
        const db = database();
        sql = db.sql;
        const account = await stripe('account');
        payoutCurrency = account.default_currency;
        saleCurrency = payoutCurrency === 'eur' ? 'gbp' : 'eur';
        env = { DB: db.DB, STRIPE_SECRET_KEY: STRIPE_KEY, ADMIN_TOKEN: 'e2e-admin', AFFILIATE_PAYOUT_CURRENCY: payoutCurrency };
        // An affiliate without a Connect account: the run records a manual payout.
        sql.exec("INSERT INTO affiliates (id,email,code,status,created_at) VALUES (1,'e2e@example.test','e2e','active',0)");
        intent = await stripe('payment_intents', {
            amount: '5000', currency: saleCurrency, payment_method: 'pm_card_visa', confirm: 'true',
            'payment_method_types[0]': 'card', description: 'cf-affiliate e2e foreign-currency sale',
        });
        assert.equal(intent.status, 'succeeded');
        sql.prepare(`INSERT INTO conversions (id,affiliate_id,stripe_session_id,payment_intent,amount_cents,commission_cents,status,created_at,currency)
            VALUES (1,1,'cs_e2e_fx',?,5000,1000,'approved',0,?)`).run(intent.id, saleCurrency);
    });

    afterAll(async () => {
        if (intent) await stripe('refunds', { payment_intent: intent.id }).catch(() => {});
        sql?.close();
    });

    it('pays the commission in the platform currency at Stripe\'s own rate for that sale', async (ctx) => {
        const settled = await stripe(`payment_intents/${intent.id}?expand[]=latest_charge.balance_transaction`);
        const txn = settled.latest_charge.balance_transaction;
        // An account that settles this currency natively has nothing to convert.
        if (txn.currency !== payoutCurrency) ctx.skip();

        const res = await runPayouts(context(env, '/api/admin/payouts-run', {}));
        const body = await res.json();
        assert.equal(res.status, 200, JSON.stringify(body));

        const expected = Math.round(1000 * txn.amount / settled.latest_charge.amount);
        const row = sql.prepare('SELECT payout_cents, payout_currency, fx_source, status FROM conversions WHERE id=1').get();
        assert.deepEqual({ ...row }, { payout_cents: expected, payout_currency: payoutCurrency, fx_source: txn.id, status: 'paid' });
        const payout = sql.prepare('SELECT amount_cents, currency, status FROM payouts').get();
        assert.deepEqual({ ...payout }, { amount_cents: expected, currency: payoutCurrency, status: 'manual' });
    });
});
