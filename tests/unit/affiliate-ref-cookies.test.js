import { afterEach, it } from 'vitest';
import assert from 'node:assert/strict';
import { applyAffiliateRef, refCookieName } from '../../src/ref.ts';
import { attachAffiliateAttribution } from '../../src/checkout.ts';
import { database as realDB } from './_db.js';

const COOKIE = '__Host-holotype_ref';
const SETTINGS = { AFFILIATE_REF_COOKIE: COOKIE, AFFILIATE_REF_LEGACY_COOKIE: 'holotype_ref' };
const databases = [];
const originalWarn = console.warn;
afterEach(() => {
    for (const sql of databases.splice(0)) sql.close();
    console.warn = originalWarn;
});

function setup() {
    const { sql, DB } = realDB();
    databases.push(sql);
    sql.exec("INSERT INTO affiliates (id,email,code,status,promo_code_id,created_at) VALUES "
        + "(1,'alice@example.test','alice','active','promo_alice',0),"
        + "(2,'bob@example.test','bob','active','promo_bob',0),"
        + "(3,'paused@example.test','paused','suspended','promo_paused',0)");
    return { sql, env: { DB, ...SETTINGS } };
}

function request(cookie = '', path = '/api/checkout', origin = 'https://shop.example.test') {
    return new Request(origin + path, { headers: { Cookie: cookie } });
}

async function attribution(env, cookie, origin) {
    const params = new URLSearchParams({ 'metadata[project]': 'shop', client_reference_id: 'site-reference' });
    await attachAffiliateAttribution(params, request(cookie, '/api/checkout', origin), env);
    return params;
}

it('sets a protected 30-day root cookie and retires the known legacy cookie without losing response headers', async () => {
    const { sql, env } = setup();
    const response = await applyAffiliateRef(request('', '/?ref=alice'), env, async () => new Response('shop', {
        headers: { 'Set-Cookie': 'unrelated=keep; Path=/', 'Content-Type': 'text/html', 'X-Page': 'kept' },
    }));
    assert.equal(await response.text(), 'shop');
    assert.equal(response.headers.get('X-Page'), 'kept');
    assert.deepEqual(response.headers.getSetCookie(), [
        'unrelated=keep; Path=/',
        `${COOKIE}=alice; Max-Age=2592000; HttpOnly; SameSite=Lax; Path=/; Secure`,
        'holotype_ref=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/; Secure',
    ]);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 1);
});

it('keeps last-link attribution and refreshes matching referrals without recording duplicate clicks', async () => {
    const { sql, env } = setup();
    const first = await applyAffiliateRef(request('holotype_ref=alice', '/?ref=bob'), env, async () => new Response('shop'));
    assert.equal(first.headers.getSetCookie()[0].split(';')[0], `${COOKIE}=bob`);
    const nextCookie = `${COOKIE}=bob; holotype_ref=alice`;
    const params = await attribution(env, nextCookie);
    assert.equal(params.get('metadata[affiliate_id]'), '2');
    assert.equal(params.get('discounts[0][promotion_code]'), 'promo_bob');
    assert.equal(params.get('client_reference_id'), 'site-reference');
    const again = await applyAffiliateRef(request(nextCookie, '/?ref=bob'), env, async () => new Response('shop'));
    assert.ok(again.headers.getSetCookie()[0].includes('Max-Age=2592000'));
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 1);
});

it('accepts duplicate cookies only when their decoded referral codes agree', async () => {
    const { sql, env } = setup();
    console.warn = () => assert.fail('Matching referral cookies should not log a conflict');
    for (const cookie of [
        `${COOKIE}=alice; ${COOKIE}=alice`,
        `${COOKIE}=%61lice; ${COOKIE}=alice`,
        'holotype_ref=alice; holotype_ref=%61lice',
    ]) {
        const params = await attribution(env, cookie);
        assert.equal(params.get('metadata[affiliate_id]'), '1');
        assert.equal(params.get('discounts[0][promotion_code]'), 'promo_alice');
    }
    const same = await applyAffiliateRef(request(`${COOKIE}=alice; ${COOKIE}=%61lice`, '/?ref=alice'), env,
        async () => new Response('shop'));
    assert.ok(same);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 0);
});

it('skips conflicting attribution in either header order and logs no referral values or customer data', async () => {
    const warnings = [];
    console.warn = message => warnings.push(JSON.parse(message));
    const env = { ...SETTINGS, DB: { prepare() { assert.fail('A conflict must not resolve either affiliate'); } } };
    for (const cookie of [
        `${COOKIE}=alice; ${COOKIE}=bob; holotype_ref=alice`,
        `${COOKIE}=bob; ${COOKIE}=alice; holotype_ref=bob`,
        'holotype_ref=alice; holotype_ref=bob',
        'holotype_ref=bob; holotype_ref=alice',
    ]) {
        const params = await attribution(env, cookie);
        assert.deepEqual([...params], [['metadata[project]', 'shop'], ['client_reference_id', 'site-reference']]);
    }
    assert.deepEqual(warnings, [COOKIE, COOKIE, 'holotype_ref', 'holotype_ref'].map(cookie_name => ({
        event: 'affiliate_ref_cookie_conflict', cookie_name,
    })));
});

it('uses an unambiguous legacy referral only when the current cookie is absent, without extending its expiry', async () => {
    const { sql, env } = setup();
    const legacy = await attribution(env, 'holotype_ref=alice');
    assert.equal(legacy.get('metadata[affiliate_id]'), '1');
    // Neither checkout nor an ordinary visit sets/refreshes a referral cookie.
    assert.equal(await applyAffiliateRef(request('holotype_ref=alice', '/shop'), env,
        async () => assert.fail('An ordinary visit should fall through')), null);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 0);
    for (const cookie of [
        `${COOKIE}=bob; holotype_ref=alice`,
        `holotype_ref=alice; ${COOKIE}=bob`,
        `${COOKIE}=bob; holotype_ref=alice; holotype_ref=paused`,
    ]) {
        assert.equal((await attribution(env, cookie)).get('metadata[affiliate_id]'), '2');
    }
});

it('does not revive legacy attribution when the current referral is empty, malformed, unknown or inactive', async () => {
    const { env } = setup();
    for (const code of ['', '%ZZ', 'unknown', 'paused']) {
        const params = await attribution(env, `${COOKIE}=${code}; holotype_ref=alice`);
        assert.equal(params.get('metadata[affiliate_id]'), null);
        assert.equal(params.get('discounts[0][promotion_code]'), null);
    }
    const params = await attribution(env, `${COOKIE}=alice; ${COOKIE}=%ZZ; holotype_ref=alice`);
    assert.equal(params.get('metadata[affiliate_id]'), null);
});

it('repairs conflicting legacy referrals on a fresh valid link while unknown links leave attribution untouched', async () => {
    const { sql, env } = setup();
    console.warn = () => {};
    const conflict = 'holotype_ref=alice; holotype_ref=bob';
    for (const code of ['unknown', 'paused']) {
        assert.equal(await applyAffiliateRef(request(conflict, `/?ref=${code}`), env,
            async () => assert.fail('Unknown/inactive links must fall through')), null);
    }
    const fresh = await applyAffiliateRef(request(conflict, '/?ref=bob'), env, async () => new Response('shop'));
    assert.equal(fresh.headers.getSetCookie()[0].split(';')[0], `${COOKIE}=bob`);
    const params = await attribution(env, `${COOKIE}=bob; ${conflict}`);
    assert.equal(params.get('metadata[affiliate_id]'), '2');
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 1);
});

it('supports HTTP loopback cookies and duplicate handling without weakening non-loopback cookie names', async () => {
    const { env } = setup();
    console.warn = () => {};
    for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
        const fresh = await applyAffiliateRef(request('', '/?ref=alice', origin), env, async () => new Response('shop'));
        assert.deepEqual(fresh.headers.getSetCookie(), [
            'holotype_ref=alice; Max-Age=2592000; HttpOnly; SameSite=Lax; Path=/',
        ]);
        assert.equal((await attribution(env, 'holotype_ref=alice', origin)).get('metadata[affiliate_id]'), '1');
        assert.equal((await attribution(env, 'holotype_ref=alice; holotype_ref=bob', origin)).get('metadata[affiliate_id]'), null);
    }
    const remote = request('', '/', 'http://shop.example.test');
    assert.equal(refCookieName(env, remote), COOKIE);
    assert.equal(refCookieName(env, request('', '/', 'https://localhost')), COOKIE);
    assert.equal(refCookieName({}), 'affiliate_ref');
});
