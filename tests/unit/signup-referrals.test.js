import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { recordSignupReferral } from '../../src/referral.js';
import { attachAffiliateAttribution } from '../../src/checkout.js';
import { recordConversion } from '../../src/webhook.js';
import { database } from './_db.js';

const cleanups = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; for (const fn of cleanups.splice(0).reverse()) fn(); });

const SITE = 'https://shop.example';

function setup() {
    const { sql, DB } = database();
    cleanups.push(() => sql.close());
    sql.exec(`INSERT INTO affiliates (id,email,code,status,commission_pct,promo_code_id,promo_code,created_at) VALUES
        (1,'nick@example.test','nick','active',20,'promo_nick','NICK10',0),
        (2,'bob@example.test','bob','active',20,'promo_bob','BOB10',0)`);
    // Stripe: promo code lookup by code, as findPromotionCode calls it.
    globalThis.fetch = async url => {
        const code = new URL(url).searchParams.get('code');
        const promos = { NICK10: 'promo_nick', BOB10: 'promo_bob' };
        return Response.json({ data: promos[code] ? [{ id: promos[code], code, active: true }] : [] });
    };
    const env = { DB, SITE_URL: SITE, STRIPE_SECRET_KEY: 'sk_test_unused' };
    const referral = userId => sql.prepare('SELECT affiliate_id, source, stripe_customer_id, converted_at FROM referrals WHERE user_id=?').get(userId);
    return { sql, env, referral };
}

const withCookie = cookie => new Request(SITE + '/api/checkout', { headers: cookie ? { Cookie: cookie } : {} });

async function checkout(env, request, options) {
    const params = new URLSearchParams();
    await attachAffiliateAttribution(params, request, env, options);
    return Object.fromEntries([...params].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
}

async function pay(env, id, metadata, { promo = null, created = 1800000000 } = {}) {
    const discounts = promo ? [{ promotion_code: promo }] : [];
    return recordConversion({ id, amount_total: 5000, currency: 'usd', customer: 'cus_1', metadata, discounts,
        total_details: { amount_discount: promo ? 500 : 0 } }, { id: 'evt_' + id, created }, env);
}

describe('signup referrals', () => {
    it('credits a purchase made long after the cookie is gone, in another browser', async () => {
        const { sql, env, referral } = setup();
        assert.equal((await recordSignupReferral(withCookie('affiliate_ref=nick'), env, 'user_1')).affiliate_id, 1);
        // 60 days later, no cookie at all.
        const metadata = await checkout(env, withCookie(''), { userId: 'user_1' });
        assert.equal(metadata.affiliate_id, '1');
        assert.equal(metadata.affiliate_user_id, 'user_1');
        await pay(env, 'cs_1', metadata);
        assert.deepEqual({ ...sql.prepare('SELECT affiliate_id, user_id FROM conversions').get() }, { affiliate_id: 1, user_id: 'user_1' });
        assert.deepEqual({ ...referral('user_1') }, { affiliate_id: 1, source: 'signup', stripe_customer_id: 'cus_1', converted_at: 1800000000000 });
    });

    it('accepts the signup headers instead of a Request (Better Auth hooks pass ctx.headers)', async () => {
        const { env, referral } = setup();
        await recordSignupReferral(new Headers({ Cookie: 'affiliate_ref=nick' }), env, 'user_2');
        assert.equal(referral('user_2').affiliate_id, 1);
    });

    it('never overwrites the signup referral with a later cookie', async () => {
        const { env, referral } = setup();
        await recordSignupReferral(withCookie('affiliate_ref=nick'), env, 'user_1');
        assert.equal((await recordSignupReferral(withCookie('affiliate_ref=bob'), env, 'user_1')).affiliate_id, 1);
        const metadata = await checkout(env, withCookie('affiliate_ref=bob'), { userId: 'user_1' });
        assert.equal(metadata.affiliate_id, '1');
        assert.equal(referral('user_1').affiliate_id, 1);
    });

    it('lets a promo code win at the first payment, then fixes the referral', async () => {
        const { sql, env, referral } = setup();
        await recordSignupReferral(withCookie('affiliate_ref=nick'), env, 'user_1');
        const metadata = await checkout(env, withCookie(''), { userId: 'user_1', promoCode: 'BOB10' });
        assert.equal(metadata.affiliate_id, '2');
        await pay(env, 'cs_1', metadata, { promo: 'promo_bob' });
        assert.deepEqual([referral('user_1').affiliate_id, referral('user_1').source], [2, 'promo_code']);
        // After the first payment a different code no longer moves the user.
        const later = await checkout(env, withCookie(''), { userId: 'user_1', promoCode: 'NICK10' });
        await pay(env, 'cs_2', later, { promo: 'promo_nick' });
        assert.equal(referral('user_1').affiliate_id, 2);
        assert.deepEqual(sql.prepare('SELECT affiliate_id FROM conversions ORDER BY id').all().map(r => r.affiliate_id), [2, 1]);
    });

    it('stores the referral at the first payment when the user had none', async () => {
        const { env, referral } = setup();
        const metadata = await checkout(env, withCookie('affiliate_ref=bob'), { userId: 'user_3' });
        await pay(env, 'cs_1', metadata);
        assert.deepEqual([referral('user_3').affiliate_id, referral('user_3').source], [2, 'checkout']);
    });

    it('records nothing without a valid cookie, and falls back to the cookie when the affiliate is suspended', async () => {
        const { sql, env, referral } = setup();
        assert.equal(await recordSignupReferral(withCookie(''), env, 'user_1'), null);
        assert.equal(await recordSignupReferral(withCookie('affiliate_ref=unknown'), env, 'user_1'), null);
        assert.equal(referral('user_1'), undefined);
        await recordSignupReferral(withCookie('affiliate_ref=nick'), env, 'user_4');
        sql.exec("UPDATE affiliates SET status='suspended' WHERE id=1");
        assert.equal((await checkout(env, withCookie('affiliate_ref=bob'), { userId: 'user_4' })).affiliate_id, '2');
        await assert.rejects(checkout(env, withCookie(''), { userId: '' }), TypeError);
    });
});
