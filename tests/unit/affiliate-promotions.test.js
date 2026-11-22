import { it as vitestIt } from 'vitest';
const it = (title, run) => vitestIt(title, async () => {
 const cleanups=[];
 try { await run({ after: cleanup => cleanups.push(cleanup) }); }
 finally { for(const cleanup of cleanups.reverse()) await cleanup(); }
});
import assert from 'node:assert/strict';
import { attachAffiliateAttribution } from '../../src/checkout.ts';
import { recordConversion } from '../../src/webhook.ts';
import { database as realDB } from './_db.js';

function database(t) {
    const db = realDB();
    t.after(() => db.sql.close());
    db.sql.exec(`INSERT INTO affiliates (id,email,code,status,commission_pct,promo_code_id,created_at) VALUES
        (7,'alice@example.test','alice','active',20,'promo_alice',0),
        (8,'bob@example.test','bob','active',30,'promo_bob',0),
        (9,'inactive@example.test','inactive','suspended',20,'promo_inactive',0)`);
    return db;
}
function mockFetch(t, handler) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    t.after(() => { globalThis.fetch = original; });
}
const envFor = DB => ({ DB, STRIPE_SECRET_KEY: 'test-key', AFFILIATE_REF_COOKIE: 'affiliate_ref' });
const session = extra => ({
    id: 'cs_promo', amount_total: 4500, currency: 'usd', payment_status: 'paid',
    customer_details: { email: 'buyer@example.test' },
    metadata: { affiliate_id: '7', affiliate_code: 'alice', affiliate_source: 'cookie' },
    ...extra,
});
const event = { id: 'evt_promo', created: 1000 };

for (const cookie of ['affiliate_ref=alice', '', 'affiliate_ref=alice; affiliate_ref=bob']) {
    it(`uses an entered affiliate promotion with ${cookie || 'no cookies'}`, async t => {
        const { DB } = database(t);
        mockFetch(t, async url => {
            assert.equal(new URL(url).searchParams.get('code'), 'bOb10');
            assert.equal(new URL(url).searchParams.get('active'), 'true');
            return Response.json({ data: [{ id: 'promo_bob', code: 'BOB10', active: true }] });
        });
        const params = new URLSearchParams({ 'metadata[project]': 'holotype', client_reference_id: 'legacy-referral' });
        await attachAffiliateAttribution(params, new Request('https://shop.example/checkout', { headers: { Cookie: cookie } }),
            envFor(DB), { promoCode: ' bOb10 ' });
        assert.equal(params.get('metadata[affiliate_id]'), '8');
        assert.equal(params.get('metadata[affiliate_source]'), 'promo_code');
        assert.equal(params.get('metadata[affiliate_cookie_id]'), cookie === 'affiliate_ref=alice' ? '7' : null);
        assert.deepEqual(params.getAll('discounts[0][promotion_code]'), ['promo_bob']);
        assert.equal(params.get('metadata[project]'), 'holotype');
        assert.equal(params.get('client_reference_id'), 'legacy-referral');
    });
}

it('applies a general store promotion while keeping cookie attribution', async t => {
    const { DB } = database(t);
    mockFetch(t, async () => Response.json({ data: [{ id: 'promo_store', code: 'STORE10', active: true,
        metadata: { affiliate_id: '8' } }] }));
    const params = new URLSearchParams();
    await attachAffiliateAttribution(params, new Request('https://shop.example/checkout', {
        headers: { Cookie: 'affiliate_ref=alice' },
    }), envFor(DB), { promoCode: 'STORE10' });
    assert.equal(params.get('metadata[affiliate_id]'), '7');
    assert.equal(params.get('metadata[affiliate_source]'), 'cookie');
    assert.deepEqual(params.getAll('discounts[0][promotion_code]'), ['promo_store']);
});

for (const promotion of [null, { id: 'promo_bob', code: 'BOB10', active: false },
    { id: 'promo_bob', code: 'BOB10', active: true, expires_at: 1 },
    { id: 'promo_bob', code: 'ANOTHER', active: true }]) {
    it(`rejects an unavailable entered promotion: ${JSON.stringify(promotion)}`, async t => {
        const { DB } = database(t);
        mockFetch(t, async () => Response.json({ data: promotion ? [promotion] : [] }));
        const params = new URLSearchParams();
        await assert.rejects(attachAffiliateAttribution(params, new Request('https://shop.example/checkout', {
            headers: { Cookie: 'affiliate_ref=alice' },
        }), envFor(DB), { promoCode: 'BOB10' }), error => error.status === 400);
        assert.equal(params.size, 0);
    });
}

for (const expanded of [false, true]) {
    it(`records the applied ${expanded ? 'expanded' : 'ID-only'} promo owner before the cookie owner`, async t => {
        const { DB, sql } = database(t);
        const result = await recordConversion(session({ discounts: [{ promotion_code: expanded
            ? { id: 'promo_bob', metadata: { affiliate_id: '7' } } : 'promo_bob' }], total_details: { amount_discount: 500 } }), event, envFor(DB));
        assert.equal(result.metadata.affiliate_id, '8');
        const row = sql.prepare('SELECT affiliate_id,amount_cents,commission_cents FROM conversions').get();
        assert.equal(row.affiliate_id, 8);
        assert.equal(row.amount_cents, 4500);
        assert.equal(row.commission_cents, 1350);
    });
}

it('attributes a promo-only purchase without referral metadata', async t => {
    const { DB, sql } = database(t);
    await recordConversion(session({ metadata: { project: 'holotype' }, discounts: [{ promotion_code: 'promo_bob' }] }), event, envFor(DB));
    assert.equal(sql.prepare('SELECT affiliate_id FROM conversions').get().affiliate_id, 8);
});

for (const discounts of [[], [{ promotion_code: 'promo_store' }], [{ promotion_code: 'promo_inactive' }]]) {
    it(`does not give an unredeemed affiliate code credit: ${JSON.stringify(discounts)}`, async t => {
        const { DB, sql } = database(t);
        const metadata = { affiliate_id: '8', affiliate_code: 'bob', affiliate_source: 'promo_code' };
        assert.equal(await recordConversion(session({ metadata, discounts }), event, envFor(DB)), null);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM conversions').get().n, 0);
        const result = await recordConversion(session({ metadata: { ...metadata, affiliate_cookie_id: '7', affiliate_cookie_code: 'alice' }, discounts }), event, envFor(DB));
        assert.equal(result.metadata.affiliate_id, '7');
        assert.equal(sql.prepare('SELECT affiliate_id FROM conversions').get().affiliate_id, 7);
    });
}

it('retains cookie attribution when an attached promotion gave no discount', async t => {
    const { DB, sql } = database(t);
    await recordConversion(session({ discounts: [{ promotion_code: 'promo_bob' }], total_details: { amount_discount: 0 } }), event, envFor(DB));
    assert.equal(sql.prepare('SELECT affiliate_id FROM conversions').get().affiliate_id, 7);
});

it('verifies Stripe discounts when the paid event omits them and preserves retry snapshots', async t => {
    const { DB, sql } = database(t);
    let calls = 0;
    mockFetch(t, async url => {
        calls++;
        assert.equal(new URL(url).pathname, '/v1/checkout/sessions/cs_promo');
        assert.equal(new URL(url).searchParams.get('expand[]'), 'discounts.promotion_code');
        return Response.json({ id: 'cs_promo', discounts: [{ promotion_code: { id: 'promo_bob' } }], total_details: { amount_discount: 500 } });
    });
    const purchase = session({ metadata: { affiliate_id: '7', affiliate_attribution_version: 'promo-first-v1' } });
    const attributed = await recordConversion(purchase, event, envFor(DB));
    assert.equal(attributed.metadata.affiliate_id, '8');
    sql.exec("UPDATE conversions SET status='approved'; UPDATE affiliates SET commission_pct=90, status='suspended', promo_code_id='promo_replaced' WHERE id=8");
    const retry = await recordConversion(purchase, event, envFor(DB), [{ description: 'Test product', quantity: 1 }]);
    assert.equal(retry.metadata.affiliate_id, '8');
    assert.equal(retry.metadata.affiliate_code, 'bob');
    assert.equal(calls, 1);
    const row = sql.prepare('SELECT affiliate_id,commission_pct,commission_cents,status,items_json FROM conversions').get();
    assert.equal(row.affiliate_id, 8);
    assert.equal(row.commission_pct, 30);
    assert.equal(row.commission_cents, 1350);
    assert.equal(row.status, 'approved');
    assert.equal(JSON.parse(row.items_json)[0].name, 'Test product');
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM conversions').get().n, 1);
});

for (const failure of ['http', 'network', 'missing-discounts', 'wrong-session']) {
    it(`does not insert provisional attribution when verification fails: ${failure}`, async t => {
        const { DB, sql } = database(t);
        mockFetch(t, async () => {
            if (failure === 'network') throw new Error('Network failure');
            if (failure === 'http') return new Response('', { status: 503 });
            return Response.json(failure === 'missing-discounts' ? { id: 'cs_promo' } : { id: 'cs_other', discounts: [] });
        });
        await assert.rejects(recordConversion(session({ metadata: { affiliate_id: '7', affiliate_attribution_version: 'promo-first-v1' } }), event, envFor(DB)));
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM conversions').get().n, 0);
    });
}

it('rejects ambiguous affiliate ownership instead of choosing the first database row', async t => {
    const { DB, sql } = database(t);
    sql.exec("UPDATE affiliates SET promo_code_id='promo_bob' WHERE id=7");
    await assert.rejects(recordConversion(session({ discounts: [{ promotion_code: 'promo_bob' }] }), event, envFor(DB)), /ambiguous/);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM conversions').get().n, 0);
});
