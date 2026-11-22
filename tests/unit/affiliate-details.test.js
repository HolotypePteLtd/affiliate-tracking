import { describe, it, afterEach } from 'vitest';
const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
import assert from 'node:assert/strict';
import { database as realDB } from './_db.js';
import { recordConversion } from '../../src/webhook.ts';
import { createSession } from '../../functions/api/_affiliate-auth.ts';
import { onRequestGet as me } from '../../functions/api/affiliate/me.ts';
import { onRequestGet as exportCSV } from '../../functions/api/affiliate/export.ts';
import { onRequestPost as runPayouts } from '../../functions/api/admin/payouts-run.ts';
import { currencyDecimals } from '../../src/money.ts';

async function setup(t) {
    const { sql, DB } = realDB();
    cleanups.push(() => sql.close());
    sql.exec("INSERT INTO affiliates (id,email,code,status,commission_pct,created_at) VALUES (1,'partner@example.test','partner','active',20,0),(2,'other@example.test','other','active',50,0)");
    const env = { DB, AFFILIATE_SESSION_SECRET: 'details-test-secret', ADMIN_TOKEN: 'admin-test', STRIPE_SECRET_KEY: 'not-used' };
    const session = await createSession(1, env.AFFILIATE_SESSION_SECRET);
    const context = query => ({ env, request: new Request('https://shop.example/api/affiliate/me' + query,
        { headers: { Cookie: '__Host-aff_session=' + session } }) });
    const get = async (query = '') => (await me(context(query))).json();
    return { sql, env, context, get };
}
function purchase(overrides = {}) {
    return { id: 'cs_details', amount_total: 5000, currency: 'usd', payment_intent: 'pi_private',
        customer_details: { email: 'private-buyer@example.test', address: { country: 'SG', city: 'Singapore', line1: 'Private address' } },
        metadata: { affiliate_id: '1', locale: 'zh' }, ...overrides };
}
function item(id, name, quantity = 1) {
    return { description: name, quantity, price: { nickname: 'Pro', product: { id, name, metadata: { private: 'Do not expose' } } } };
}

describe('affiliate purchase details and privacy', () => {
    it('enriches retries while preserving original money, currency, rate, timestamp, product snapshot, and status', async t => {
        const { sql, env, get } = await setup(t);
        await recordConversion(purchase(), { id: 'evt_details', created: 1791633600 }, env);
        sql.exec("UPDATE affiliates SET commission_pct=50 WHERE id=1; UPDATE conversions SET status='paid',paid_at=1234");
        await recordConversion(purchase({ amount_total: 9999, currency: 'eur' }), { id: 'evt_retry' }, env, [item('prod_one', 'Plugin', 2)]);
        await recordConversion(purchase(), { id: 'evt_retry2' }, env, [item('prod_one', 'Renamed plugin')]);
        assert.equal(sql.prepare('SELECT COUNT(*) as n FROM conversions').get().n, 1);
        const data = await get();
        const c = data.conversions[0];
        assert.equal(c.amount_cents, 5000);
        assert.equal(c.commission_cents, 1000);
        assert.equal(c.commission_pct, 20);
        assert.equal(c.currency, 'usd');
        assert.equal(c.currency_decimals, 2);
        assert.equal(c.country, 'SG');
        assert.equal(c.created_at, 1791633600000);
        assert.equal(c.status, 'paid');
        assert.deepEqual(c.items, [{ product_id: 'prod_one', name: 'Plugin', variant: 'Pro', quantity: 2 }]);
        for (const privateValue of ['private-buyer', 'Private address', 'pi_private', 'Do not expose']) {
            assert.ok(!JSON.stringify(data).includes(privateValue), privateValue);
        }
        assert.equal('customer_email' in c, false);
        assert.equal('stripe_session_id' in c, false);
    });

    it('matches any product in a multi-item order and combines product, status, and date filters', async t => {
        const { sql, env, get, context } = await setup(t);
        await recordConversion(purchase(), { created: Date.parse('2026-10-10T12:00:00Z') / 1000 }, env,
            [item('prod_one', 'Plugin A'), item('prod_two', 'Plugin B')]);
        await recordConversion(purchase({ id: 'cs_foreign', metadata: { affiliate_id: '2' } }), {}, env, [item('prod_private', 'Foreign product')]);
        sql.exec("UPDATE conversions SET status='approved' WHERE affiliate_id=1");
        assert.equal((await get('?product=prod_two&status=approved&start_date=2026-10-10&end_date=2026-10-10')).conversions.length, 1);
        assert.equal((await get('?product=prod_two&status=paid')).conversions.length, 0);
        const data = await get('?product=prod_private');
        assert.equal(data.conversions.length, 0);
        assert.deepEqual(data.products.map(p => p.id), ['prod_one', 'prod_two']);
        assert.equal((await me(context('?status=anything'))).status, 400);
    });

    it('keeps legacy missing fields unknown and uses Stripe currency units', async t => {
        const { sql, get } = await setup(t);
        sql.exec("INSERT INTO conversions (affiliate_id,stripe_session_id,amount_cents,commission_cents,status,created_at) VALUES (1,'cs_legacy',5000,1000,'approved',0)");
        const c = (await get()).conversions[0];
        assert.equal(c.currency, null);
        assert.equal(c.currency_decimals, null);
        assert.equal(c.country, null);
        assert.equal(c.commission_pct, null);
        assert.deepEqual(c.items, []);
        assert.equal(currencyDecimals('JPY'), 0);
        assert.equal(currencyDecimals('usd'), 2);
        assert.equal(currencyDecimals('isk'), 2);
        assert.equal(currencyDecimals('ugx'), 2);
        assert.equal(currencyDecimals('bhd'), 3);
    });

    it('paginates payout history independently and never exposes another partner or Stripe transfer details', async t => {
        const { sql, get } = await setup(t);
        const insert = sql.prepare("INSERT INTO payouts (affiliate_id,amount_cents,status,created_at,currency,stripe_transfer_id,paid_at) VALUES (?,1000,'sent',?,'usd','tr_private',?)");
        for (let i = 1; i <= 26; i++) insert.run(1, i, i + 10);
        insert.run(2, 999, 1000);
        const data = await get('?payout_page=3&payout_per_page=10');
        assert.deepEqual(data.payouts_pagination, { page: 3, per_page: 10, total: 26, total_pages: 3 });
        assert.equal(data.payouts.length, 6);
        assert.equal(data.payouts[0].currency, 'usd');
        assert.equal(data.payouts[0].created_at, 6);
        assert.equal(data.payouts[0].paid_at, 16);
        assert.equal(JSON.stringify(data).includes('tr_private'), false);
        assert.equal((await get('?payout_page=999&payout_per_page=10')).payouts_pagination.page, 3);
    });
});

describe('affiliate CSV exports', () => {
    it('exports every matching row beyond one query page, with safe strings and no customer data', async t => {
        const { sql, env, context } = await setup(t);
        const insert = sql.prepare("INSERT INTO conversions (affiliate_id,stripe_session_id,amount_cents,commission_cents,currency,customer_country,commission_pct,items_json,customer_email,status,created_at) VALUES (1,?,5000,1000,'usd','US',20,?,'private-buyer@example.test','approved',?)");
        const items = JSON.stringify([{ product_id: 'prod_formula', name: '=HYPERLINK("bad")', quantity: 1 }]);
        for (let i = 0; i < 230; i++) insert.run('cs_export_' + i, items, 1000);
        await recordConversion(purchase({ id: 'cs_other', metadata: { affiliate_id: '2' } }), {}, env, [item('prod_formula', 'Foreign purchase')]);
        const response = await exportCSV(context('?product=prod_formula&status=approved'));
        assert.equal(response.status, 200);
        assert.match(response.headers.get('Content-Disposition'), /attachment/);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        const csv = await response.text();
        assert.equal(csv.trim().split('\r\n').length, 231);
        assert.ok(csv.includes("'=HYPERLINK"));
        assert.ok(csv.includes('"USD","2","50.00","5000","10.00","1000"'));
        assert.ok(!csv.includes('private-buyer') && !csv.includes('Foreign purchase'));
        assert.ok(!csv.includes('cs_export_'));
        const empty = await exportCSV(context('?status=paid'));
        assert.equal((await empty.text()).trim().split('\r\n').length, 1);
    });

    it('rejects signed-out/suspended accounts and invalid export filters', async t => {
        const { sql, env, context } = await setup(t);
        assert.equal((await exportCSV({ env, request: new Request('https://shop.example/api/affiliate/export') })).status, 401);
        assert.equal((await exportCSV(context('?start_date=2026-02-30'))).status, 400);
        sql.exec("UPDATE affiliates SET status='suspended' WHERE id=1");
        assert.equal((await exportCSV(context(''))).status, 401);
    });
});

describe('currency-safe payout reporting', () => {
    it('does not send foreign or unknown commission amounts as USD', async t => {
        const { sql, env } = await setup(t);
        sql.exec("INSERT INTO conversions (affiliate_id,stripe_session_id,amount_cents,commission_cents,currency,status,created_at) VALUES (1,'cs_eur',5000,1000,'eur','approved',0)");
        const response = await runPayouts({ env, request: new Request('https://shop.example/api/admin/payouts-run', {
            method: 'POST', headers: { 'x-admin-token': env.ADMIN_TOKEN }, body: '{}',
        }) });
        assert.equal(response.status, 409);
        assert.equal(sql.prepare('SELECT COUNT(*) as n FROM payouts').get().n, 0);
        assert.equal(sql.prepare('SELECT status FROM conversions').get().status, 'approved');
    });
});
