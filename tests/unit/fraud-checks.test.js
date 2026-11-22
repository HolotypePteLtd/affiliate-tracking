import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { applyAffiliateRef } from '../../src/ref.js';
import { attachAffiliateAttribution } from '../../src/checkout.js';
import { recordConversion } from '../../src/webhook.js';
import { releaseHeldConversions } from '../../src/hold.js';
import { hashIp } from '../../src/ip.js';
import { onRequestGet as adminConversions } from '../../functions/api/admin/conversions.js';
import { database } from './_db.js';

const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function setup() {
    const { sql, DB } = database();
    cleanups.push(() => sql.close());
    sql.exec("INSERT INTO affiliates (id,email,code,status,commission_pct,created_at) VALUES (1,'Partner@Example.test','partner','active',20,0)");
    const env = { DB, AFFILIATE_IP_SALT: 'salt', ADMIN_TOKEN: 'admin-token' };
    const clicks = () => sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n;
    return { sql, env, clicks };
}

function visit(env, { ip = '203.0.113.7', ua = BROWSER, cookie = '' } = {}) {
    const headers = { 'cf-connecting-ip': ip, Cookie: cookie };
    if (ua !== null) headers['user-agent'] = ua;
    return applyAffiliateRef(new Request('https://shop.example/?ref=partner', { headers }), env, async () => new Response('page'));
}

function purchase(overrides = {}) {
    return { id: 'cs_1', amount_total: 5000, currency: 'usd', payment_intent: 'pi_1',
        customer_details: { email: 'buyer@example.test' }, metadata: { affiliate_id: '1' }, ...overrides };
}

describe('click fraud checks', () => {
    it('does not count link previews or crawlers, and gives them no cookie', async () => {
        const { env, clicks } = setup();
        for (const ua of ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'facebookexternalhit/1.1',
            'WhatsApp/2.23.20.0', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            'TelegramBot (like TwitterBot)', 'curl/8.4.0']) {
            assert.equal(await visit(env, { ua }), null, ua);
        }
        assert.equal(clicks(), 0);
        const verified = new Request('https://shop.example/?ref=partner', { headers: { 'user-agent': BROWSER } });
        Object.defineProperty(verified, 'cf', { value: { botManagement: { verifiedBot: true } } });
        assert.equal(await applyAffiliateRef(verified, env, async () => new Response('page')), null);
        assert.ok(await visit(env));
        assert.equal(clicks(), 1);
    });

    it('counts one IP once per day per affiliate even without the cookie', async () => {
        const { sql, env, clicks } = setup();
        for (let i = 0; i < 50; i++) assert.ok(await visit(env));
        assert.equal(clicks(), 1);
        await visit(env, { ip: '198.51.100.9' });
        assert.equal(clicks(), 2);
        sql.exec(`UPDATE clicks SET created_at=created_at-${25 * 60 * 60 * 1000}`);
        await visit(env);
        assert.equal(clicks(), 3);
    });
});

describe('self-referral checks', () => {
    it('flags a sale whose buyer email is the affiliate\'s own, case-insensitively', async () => {
        const { sql, env } = setup();
        await recordConversion(purchase({ customer_details: { email: ' partner@example.TEST ' } }), { id: 'evt_1' }, env);
        assert.equal(sql.prepare('SELECT fraud_reason FROM conversions').get().fraud_reason, 'self_email');
    });

    it('flags a sale made from an IP the affiliate signed in from', async () => {
        const { sql, env } = setup();
        const ipHash = await hashIp('203.0.113.7', 'salt');
        sql.prepare('INSERT INTO affiliate_ip_hashes (affiliate_id, ip_hash, last_seen_at) VALUES (1,?,0)').run(ipHash);
        const params = new URLSearchParams();
        await attachAffiliateAttribution(params, new Request('https://shop.example/api/checkout', {
            headers: { Cookie: 'affiliate_ref=partner', 'cf-connecting-ip': '203.0.113.7' } }), env);
        assert.equal(params.get('metadata[affiliate_buyer_ip_hash]'), ipHash);
        const metadata = Object.fromEntries([...params].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
        await recordConversion(purchase({ metadata, discounts: [], total_details: { amount_discount: 0 } }), { id: 'evt_2' }, env);
        assert.equal(sql.prepare('SELECT fraud_reason FROM conversions').get().fraud_reason, 'self_ip');
    });

    it('leaves an ordinary sale unflagged', async () => {
        const { sql, env } = setup();
        sql.prepare("INSERT INTO affiliate_ip_hashes (affiliate_id, ip_hash, last_seen_at) VALUES (1,'other-hash',0)").run();
        await recordConversion(purchase({ metadata: { affiliate_id: '1', affiliate_buyer_ip_hash: 'buyer-hash' } }), { id: 'evt_3' }, env);
        assert.equal(sql.prepare('SELECT fraud_reason FROM conversions').get().fraud_reason, null);
    });

    it('keeps flagged sales out of the hold period and shows the reason to admins', async () => {
        const { sql, env } = setup();
        await recordConversion(purchase({ customer_details: { email: 'partner@example.test' } }), { id: 'evt_4', created: 0 }, env);
        await recordConversion(purchase({ id: 'cs_2', payment_intent: 'pi_2' }), { id: 'evt_5', created: 0 }, env);
        assert.equal(await releaseHeldConversions({ ...env, AFFILIATE_HOLD_DAYS: '30' }, Date.now()), 1);
        assert.deepEqual(sql.prepare('SELECT stripe_session_id, status FROM conversions ORDER BY id').all().map(r => ({ ...r })),
            [{ stripe_session_id: 'cs_1', status: 'pending' }, { stripe_session_id: 'cs_2', status: 'approved' }]);
        const res = await adminConversions({ env, request: new Request('https://shop.example/api/admin/conversions', { headers: { 'x-admin-token': 'admin-token' } }) });
        const reasons = (await res.json()).conversions.map(c => [c.stripe_session_id, c.fraud_reason]);
        assert.deepEqual(reasons.sort(), [['cs_1', 'self_email'], ['cs_2', null]]);
    });
});
