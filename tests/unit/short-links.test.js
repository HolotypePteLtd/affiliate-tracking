import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { handleAffiliateApi } from '../../src/route.js';
import { handleAffiliateLink } from '../../src/links.js';
import { applyAffiliateRef } from '../../src/ref.js';
import { attachAffiliateAttribution } from '../../src/checkout.js';
import { recordConversion } from '../../src/webhook.js';
import { createSession } from '../../functions/api/_affiliate-auth.js';
import { database } from './_db.js';

const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

const SITE = 'https://shop.example';

async function setup() {
    const { sql, DB } = database();
    cleanups.push(() => sql.close());
    sql.exec(`INSERT INTO affiliates (id,email,code,status,commission_pct,created_at) VALUES
        (1,'nick@example.test','nick','active',20,0),(2,'bob@example.test','bob','active',20,0)`);
    const env = { DB, SITE_URL: SITE, AFFILIATE_SESSION_SECRET: 'links-secret', ADMIN_TOKEN: 'admin-token' };
    const nick = '__Host-aff_session=' + await createSession(1, env.AFFILIATE_SESSION_SECRET);
    const bob = '__Host-aff_session=' + await createSession(2, env.AFFILIATE_SESSION_SECRET);
    const api = (path, { method = 'GET', body, cookie = nick, headers = {} } = {}) => handleAffiliateApi(new Request(SITE + path, {
        method, headers: { Cookie: cookie, Origin: SITE, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { sql, env, api, nick, bob };
}

// Follow a short link the way a browser would, carrying cookies along.
async function click(env, path, jar = new Map()) {
    const headers = () => ({ Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'user-agent': 'Mozilla/5.0' });
    const redirect = await handleAffiliateLink(new Request(SITE + path, { headers: headers() }), env);
    assert.equal(redirect.status, 302);
    const location = redirect.headers.get('Location');
    const page = await applyAffiliateRef(new Request(location, { headers: headers() }), env, async () => new Response('page'));
    for (const cookie of page.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [name, value] = pair.split('=');
        if (value) jar.set(name, value); else jar.delete(name);
    }
    return { location, jar };
}

describe('short links', () => {
    it('lets a partner create, list and archive their own links', async () => {
        const { api, bob } = await setup();
        const created = await api('/api/affiliate/links', { method: 'POST', body: { slug: 'nick-yt', destination: '/pricing', campaign: 'YouTube' } });
        assert.equal(created.status, 201);
        const { link } = await created.json();
        assert.equal(link.url, `${SITE}/r/nick-yt`);
        const auto = await (await api('/api/affiliate/links', { method: 'POST', body: {} })).json();
        assert.match(auto.link.slug, /^nick-[0-9a-f]{6}$/);
        assert.equal(auto.link.destination, '/');

        assert.equal((await api('/api/affiliate/links', { method: 'POST', body: { slug: 'nick-yt' } })).status, 409);
        for (const destination of ['https://evil.example', '//evil.example', '/a b', '/x\\y']) {
            assert.equal((await api('/api/affiliate/links', { method: 'POST', body: { destination } })).status, 400, destination);
        }
        assert.equal((await api('/api/affiliate/links', { method: 'POST', body: { slug: 'Bad Slug' } })).status, 400);
        assert.equal((await api('/api/affiliate/links', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);

        const list = await (await api('/api/affiliate/links')).json();
        assert.equal(list.links.length, 2);
        assert.deepEqual((await (await api('/api/affiliate/links', { cookie: bob })).json()).links, []);
        // Bob can't archive Nick's link.
        assert.equal((await api('/api/affiliate/link-archive', { method: 'POST', body: { id: link.id }, cookie: bob })).status, 404);
        assert.equal((await api('/api/affiliate/link-archive', { method: 'POST', body: { id: link.id } })).status, 200);
    });

    it('redirects to the destination on the site, keeps utm parameters, and stops after archiving', async () => {
        const { api, env } = await setup();
        const { link } = await (await api('/api/affiliate/links', { method: 'POST', body: { slug: 'nick-yt', destination: '/pricing?plan=pro' } })).json();
        const { location } = await click(env, '/r/NICK-YT?utm_source=youtube&ref=bob');
        const target = new URL(location);
        assert.equal(target.origin + target.pathname, `${SITE}/pricing`);
        assert.equal(target.searchParams.get('plan'), 'pro');
        assert.equal(target.searchParams.get('utm_source'), 'youtube');
        assert.equal(target.searchParams.get('ref'), 'nick');
        assert.equal(target.searchParams.get('aff_link'), 'nick-yt');
        assert.equal(await handleAffiliateLink(new Request(SITE + '/r/unknown'), env), null);
        assert.equal(await handleAffiliateLink(new Request(SITE + '/pricing'), env), null);
        await api('/api/affiliate/link-archive', { method: 'POST', body: { id: link.id } });
        assert.equal(await handleAffiliateLink(new Request(SITE + '/r/nick-yt'), env), null);
    });

    it('counts clicks and sales per link', async () => {
        const { sql, api, env } = await setup();
        const yt = (await (await api('/api/affiliate/links', { method: 'POST', body: { slug: 'nick-yt' } })).json()).link;
        const blog = (await (await api('/api/affiliate/links', { method: 'POST', body: { slug: 'nick-blog' } })).json()).link;

        const { jar } = await click(env, '/r/nick-yt');
        await click(env, '/r/nick-yt', jar);          // reload: not a second click
        await click(env, '/r/nick-blog', jar);        // other link: a new click
        await click(env, '/r/nick-yt', new Map());    // another visitor

        const params = new URLSearchParams();
        await attachAffiliateAttribution(params, new Request(SITE + '/api/checkout', {
            headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } }), env);
        assert.equal(params.get('metadata[affiliate_link_id]'), blog.id);
        const metadata = Object.fromEntries([...params].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
        await recordConversion({ id: 'cs_1', amount_total: 5000, currency: 'usd', metadata, discounts: [], total_details: { amount_discount: 0 } }, { id: 'evt_1' }, env);

        const links = Object.fromEntries((await (await api('/api/affiliate/links')).json()).links.map(l => [l.slug, l]));
        assert.deepEqual([links['nick-yt'].clicks, links['nick-yt'].conversions], [2, 0]);
        assert.deepEqual([links['nick-blog'].clicks, links['nick-blog'].conversions, links['nick-blog'].commission_cents], [1, 1, 1000]);
        assert.equal(sql.prepare('SELECT link_id FROM conversions').get().link_id, blog.id);
        assert.ok(yt.id);
    });

    it('ignores a link that belongs to another affiliate', async () => {
        const { sql, api, env } = await setup();
        const { link } = await (await api('/api/affiliate/links', { method: 'POST', body: { slug: 'nick-yt' } })).json();
        // ?ref=bob with Nick's link: the click goes to Bob, not to Nick's link.
        await applyAffiliateRef(new Request(SITE + '/?ref=bob&aff_link=nick-yt'), env, async () => new Response('page'));
        assert.deepEqual({ ...sql.prepare('SELECT affiliate_id, link_id FROM clicks').get() }, { affiliate_id: 2, link_id: null });
        await recordConversion({ id: 'cs_2', amount_total: 1000, currency: 'usd', metadata: { affiliate_id: '2', affiliate_link_id: link.id } }, { id: 'evt_2' }, env);
        assert.equal(sql.prepare('SELECT link_id FROM conversions').get().link_id, null);
    });

    it('lets an admin manage links for any affiliate', async () => {
        const { api } = await setup();
        const headers = { 'x-admin-token': 'admin-token' };
        const created = await api('/api/admin/links', { method: 'POST', body: { affiliate_id: 2, slug: 'bob-launch', destination: '/launch' }, headers, cookie: '' });
        assert.equal(created.status, 201);
        const list = await (await api('/api/admin/links?affiliate_id=2', { headers, cookie: '' })).json();
        assert.deepEqual(list.links.map(l => l.slug), ['bob-launch']);
        assert.equal((await api('/api/admin/links?affiliate_id=99', { headers, cookie: '' })).status, 404);
        assert.equal((await api('/api/admin/links?affiliate_id=2', { cookie: '' })).status, 401);
    });
});
