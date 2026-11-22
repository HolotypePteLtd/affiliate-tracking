import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { applyAffiliateRef } from '../../src/ref.js';
import { deviceClass } from '../../src/analytics.js';
import { handleAffiliateApi } from '../../src/route.js';
import { createSession } from '../../functions/api/_affiliate-auth.js';
import { database } from './_db.js';

const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

const SITE = 'https://shop.example';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

async function setup() {
    const { sql, DB } = database();
    cleanups.push(() => sql.close());
    sql.exec(`INSERT INTO affiliates (id,email,code,name,status,created_at) VALUES
        (1,'nick@example.test','nick','Nick','active',0),(2,'bob@example.test','bob','Bob','active',0)`);
    const points = [];
    const env = { DB, ADMIN_TOKEN: 'admin', AFFILIATE_SESSION_SECRET: 'secret', AFFILIATE_ANALYTICS: { writeDataPoint: p => points.push(p) } };
    const session = '__Host-aff_session=' + await createSession(1, 'secret');
    const visit = (code, { ua = MAC, country = 'TH', referer } = {}) => {
        const request = new Request(`${SITE}/?ref=${code}`, { headers: { 'user-agent': ua, ...(referer ? { referer } : {}) } });
        Object.defineProperty(request, 'cf', { value: { country } });
        return applyAffiliateRef(request, env, async () => new Response('page'));
    };
    const get = (path, headers) => handleAffiliateApi(new Request(SITE + path, { headers }), env);
    return { sql, env, points, session, visit, get };
}

describe('click analytics', () => {
    it('stores country, device class and the referring site\'s host only', async () => {
        const { sql, points, visit } = await setup();
        await visit('nick', { ua: IPHONE, country: 'TH', referer: 'https://www.youtube.com/watch?v=private-id' });
        await visit('bob', { ua: IPAD, country: 'AU', referer: SITE + '/pricing' });
        assert.deepEqual(sql.prepare('SELECT affiliate_id, country, device, referrer_host FROM clicks ORDER BY id').all().map(r => ({ ...r })), [
            { affiliate_id: 1, country: 'TH', device: 'mobile', referrer_host: 'www.youtube.com' },
            { affiliate_id: 2, country: 'AU', device: 'tablet', referrer_host: null },
        ]);
        assert.deepEqual(points[0], { indexes: ['1'], blobs: ['nick', 'TH', 'mobile', 'www.youtube.com'], doubles: [1] });
    });

    it('classifies devices', () => {
        assert.equal(deviceClass(IPHONE), 'mobile');
        assert.equal(deviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36'), 'mobile');
        assert.equal(deviceClass('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari/537.36'), 'tablet');
        assert.equal(deviceClass(MAC), 'desktop');
        assert.equal(deviceClass(''), null);
    });
});

describe('funnel', () => {
    it('shows each partner\'s clicks, customers, sales, revenue and commission by status', async () => {
        const { sql, visit, get } = await setup();
        await visit('nick', { country: 'TH', referer: 'https://youtube.com/' });
        await visit('nick', { country: 'SG', ua: IPHONE });
        await visit('bob', { country: 'TH' });
        const now = Date.now();
        sql.exec(`INSERT INTO conversions (affiliate_id,stripe_session_id,customer_email,amount_cents,commission_cents,status,created_at,currency) VALUES
            (1,'cs_1','a@x.test',10000,2000,'pending',${now},'usd'),
            (1,'cs_2','A@x.test',5000,1000,'paid',${now},'usd'),
            (1,'cs_3','b@x.test',4000,800,'refunded',${now},'usd'),
            (1,'cs_4','c@x.test',3000,600,'approved',${now},'aud'),
            (2,'cs_old','d@x.test',9999,999,'paid',${now - 40 * 86400000},'usd')`);
        const res = await get('/api/admin/stats?days=30', { 'x-admin-token': 'admin' });
        assert.equal(res.status, 200);
        const stats = await res.json();
        const nick = stats.funnel.find(f => f.code === 'nick');
        assert.deepEqual({ clicks: nick.clicks, customers: nick.customers, sales: nick.sales, signups: nick.signups }, { clicks: 2, customers: 2, sales: 3, signups: null });
        const usd = nick.money.find(m => m.currency === 'usd');
        assert.deepEqual({ ...usd }, { currency: 'usd', revenue_cents: 15000, pending_cents: 2000, approved_cents: 0, paid_cents: 1000, refunded_cents: 800 });
        assert.equal(nick.money.find(m => m.currency === 'aud').approved_cents, 600);
        const bob = stats.funnel.find(f => f.code === 'bob');
        assert.deepEqual([bob.clicks, bob.sales, bob.money.length], [1, 0, 0]);   // the 40-day-old sale is outside the period
        assert.equal(stats.clicks_by_day.length, 30);
        assert.equal(stats.clicks_by_day.at(-1).clicks, 3);
        assert.deepEqual(stats.top_countries, [{ value: 'TH', clicks: 2 }, { value: 'SG', clicks: 1 }]);
        assert.deepEqual(stats.top_referrers, [{ value: 'youtube.com', clicks: 1 }]);
    });

    it('shows a partner only their own numbers', async () => {
        const { visit, get, session } = await setup();
        await visit('nick'); await visit('bob'); await visit('bob', { country: 'US' });
        const res = await get('/api/affiliate/stats?days=7', { Cookie: session });
        assert.equal(res.status, 200);
        const stats = await res.json();
        assert.equal(stats.funnel.code, 'nick');
        assert.equal(stats.funnel.clicks, 1);
        assert.equal(stats.clicks_by_day.reduce((sum, d) => sum + d.clicks, 0), 1);
        assert.deepEqual(stats.top_countries, [{ value: 'TH', clicks: 1 }]);
        assert.equal((await get('/api/affiliate/stats')).status, 401);
    });

    it('rejects a bad period', async () => {
        const { get } = await setup();
        for (const days of ['0', '400', 'week', '1.5']) {
            assert.equal((await get('/api/admin/stats?days=' + days, { 'x-admin-token': 'admin' })).status, 400, days);
        }
        assert.equal((await get('/api/admin/stats?affiliate_id=x', { 'x-admin-token': 'admin' })).status, 400);
    });
});
