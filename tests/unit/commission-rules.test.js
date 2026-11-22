import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { recordConversion } from '../../src/webhook.js';
import { handleAffiliateApi } from '../../src/route.js';
import { database, context } from './_db.js';

const cleanups = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; for (const fn of cleanups.splice(0).reverse()) fn(); });

const AT = Date.parse('2026-11-20T12:00:00Z');

function setup() {
    const { sql, DB } = database();
    cleanups.push(() => sql.close());
    sql.exec(`INSERT INTO affiliates (id,email,code,status,commission_pct,stripe_account_id,created_at) VALUES
        (1,'nick@example.test','nick','active',20,'acct_nick',0),(2,'bob@example.test','bob','active',20,NULL,0)`);
    const env = { DB, ADMIN_TOKEN: 'admin', STRIPE_SECRET_KEY: 'sk_test' };
    const admin = (path, body) => handleAffiliateApi(context(env, path, body).request, env);
    const rule = async body => {
        const res = await admin('/api/admin/commission-rules', body);
        assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
        return (await res.json()).rule;
    };
    let n = 0;
    const sell = async ({ affiliate = 1, total, items = [], email = 'buyer@example.test', currency = 'usd', at = AT } = {}) => {
        const id = 'cs_' + ++n;
        const lineItems = items.map(([product, amount, quantity = 1]) => ({ description: product, quantity, amount_total: amount, price: { id: 'price_' + product, product: 'prod_' + product } }));
        await recordConversion({ id, amount_total: total ?? items.reduce((s, [, a]) => s + a, 0), currency,
            customer_details: { email }, metadata: { affiliate_id: String(affiliate) }, discounts: [], total_details: { amount_discount: 0 } },
            { id: 'evt_' + id, created: Math.floor(at / 1000) }, env, lineItems);
        return { ...sql.prepare('SELECT commission_cents, commission_pct, commission_detail FROM conversions WHERE stripe_session_id=?').get(id) };
    };
    return { sql, env, admin, rule, sell };
}

describe('commission rules', () => {
    it('uses the affiliate\'s own rate when there are no rules, as before', async () => {
        const { sell } = setup();
        assert.deepEqual(await sell({ total: 10000 }), { commission_cents: 2000, commission_pct: 20, commission_detail: null });
    });

    it('picks the most specific rule for each item', async () => {
        const { rule, sell } = setup();
        const everyone = await rule({ kind: 'percent', percent: 10 });
        const annual = await rule({ kind: 'percent', percent: 40, product_id: 'prod_annual' });
        const nick = await rule({ kind: 'percent', percent: 25, affiliate_id: 1 });
        const nickAnnual = await rule({ kind: 'percent', percent: 50, affiliate_id: 1, product_id: 'prod_annual' });
        const sale = await sell({ items: [['annual', 10000], ['monthly', 2000]] });
        assert.equal(sale.commission_cents, 5000 + 500);
        assert.deepEqual(JSON.parse(sale.commission_detail).map(d => d.rule_id), [nickAnnual.id, nick.id]);
        const bob = await sell({ affiliate: 2, items: [['annual', 10000], ['monthly', 2000]] });
        assert.equal(bob.commission_cents, 4000 + 200);
        assert.deepEqual(JSON.parse(bob.commission_detail).map(d => d.rule_id), [annual.id, everyone.id]);
    });

    it('matches a rule by Stripe price id too', async () => {
        const { rule, sell } = setup();
        await rule({ kind: 'percent', percent: 50, product_id: 'price_annual' });
        assert.equal((await sell({ items: [['annual', 10000]] })).commission_cents, 5000);
    });

    it('pays a fixed amount per unit, only in its currency', async () => {
        const { rule, sell } = setup();
        await rule({ kind: 'fixed', fixed_cents: 1500, currency: 'usd', product_id: 'prod_seat' });
        assert.equal((await sell({ items: [['seat', 9000, 3]] })).commission_cents, 4500);
        assert.equal((await sell({ items: [['seat', 9000, 3]], currency: 'eur' })).commission_cents, 0);
    });

    it('moves up a tier once the affiliate reaches it this month', async () => {
        const { rule, sell } = setup();
        await rule({ kind: 'percent', percent: 20, affiliate_id: 1 });
        await rule({ kind: 'percent', percent: 30, affiliate_id: 1, min_monthly_sales: 2 });
        const rates = [];
        for (let i = 0; i < 4; i++) rates.push((await sell({ total: 1000 })).commission_cents);
        assert.deepEqual(rates, [200, 200, 300, 300]);
        // A new month starts again at the base tier.
        assert.equal((await sell({ total: 1000, at: Date.parse('2026-12-01T00:00:01Z') })).commission_cents, 200);
    });

    it('caps what one customer can earn the affiliate under a rule', async () => {
        const { rule, sell } = setup();
        await rule({ kind: 'percent', percent: 50, cap_per_customer_cents: 1200 });
        assert.equal((await sell({ total: 2000 })).commission_cents, 1000);
        assert.equal((await sell({ total: 2000, email: 'BUYER@example.test' })).commission_cents, 200);
        assert.equal((await sell({ total: 2000 })).commission_cents, 0);
        assert.equal((await sell({ total: 2000, email: 'other@example.test' })).commission_cents, 1000);
    });

    it('keeps what was earned when a rule changes later', async () => {
        const { sql, rule, admin, sell } = setup();
        const first = await rule({ kind: 'percent', percent: 30 });
        await sell({ total: 1000 });
        assert.equal((await admin('/api/admin/commission-rule-archive', { id: first.id })).status, 200);
        await rule({ kind: 'percent', percent: 5 });
        await sell({ total: 1000 });
        assert.deepEqual(sql.prepare('SELECT commission_cents FROM conversions ORDER BY id').all().map(r => r.commission_cents), [300, 50]);
    });

    it('rejects malformed rules', async () => {
        const { admin } = setup();
        for (const body of [{ kind: 'percent', percent: 120 }, { kind: 'fixed', fixed_cents: 100 }, { kind: 'bogus' },
            { kind: 'percent', percent: 10, product_id: 'annual' }, { kind: 'percent', percent: 10, min_monthly_sales: -1 }]) {
            assert.equal((await admin('/api/admin/commission-rules', body)).status, 400, JSON.stringify(body));
        }
        assert.equal((await admin('/api/admin/commission-rules', { kind: 'percent', percent: 10, affiliate_id: 99 })).status, 404);
    });
});

describe('bonuses and minimum payout', () => {
    it('adds an approved bonus line that is paid with the next payout', async () => {
        const { sql, env, admin } = setup();
        globalThis.fetch = async (url, options) => Response.json({ id: 'tr_1', amount: Number(options.body.get('amount')) });
        assert.equal((await admin('/api/admin/bonus', { affiliate_id: 1, amount_cents: 5000, currency: 'usd', note: 'Launch week' })).status, 201);
        assert.equal((await admin('/api/admin/bonus', { affiliate_id: 1, amount_cents: 5000, currency: 'usd' })).status, 400);
        assert.deepEqual({ ...sql.prepare('SELECT status, commission_cents, bonus_note FROM conversions').get() },
            { status: 'approved', commission_cents: 5000, bonus_note: 'Launch week' });
        const res = await admin('/api/admin/payouts-run', {});
        assert.equal(res.status, 200);
        assert.equal(sql.prepare('SELECT amount_cents FROM payouts').get().amount_cents, 5000);
        assert.ok(env);
    });

    it('holds back affiliates owed less than AFFILIATE_MIN_PAYOUT_CENTS', async () => {
        const { sql, env, admin } = setup();
        globalThis.fetch = async () => Response.json({ id: 'tr_1' });
        env.AFFILIATE_MIN_PAYOUT_CENTS = '5000';
        sql.exec(`INSERT INTO conversions (affiliate_id,stripe_session_id,amount_cents,commission_cents,status,created_at,currency) VALUES
            (1,'cs_a',0,3000,'approved',0,'usd'),(2,'cs_b',0,6000,'approved',0,'usd')`);
        assert.equal((await admin('/api/admin/payouts-run', {})).status, 200);
        assert.deepEqual(sql.prepare('SELECT affiliate_id FROM payouts').all().map(r => r.affiliate_id), [2]);
        sql.exec("INSERT INTO conversions (affiliate_id,stripe_session_id,amount_cents,commission_cents,status,created_at,currency) VALUES (1,'cs_c',0,2500,'approved',0,'usd')");
        assert.equal((await admin('/api/admin/payouts-run', {})).status, 200);
        assert.deepEqual(sql.prepare('SELECT affiliate_id, amount_cents FROM payouts ORDER BY id').all().map(r => [r.affiliate_id, r.amount_cents]), [[2, 6000], [1, 5500]]);
    });
});
