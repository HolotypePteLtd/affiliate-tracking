import { describe, it, afterEach } from 'vitest';
const cleanups = [];
function cleanup(fn) { cleanups.push(fn); }
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleAffiliateApi } from '../../src/route.ts';
const worker = { fetch: handleAffiliateApi };
import { createAdminSession } from '../../functions/api/_admin-auth.ts';
import { createSession } from '../../functions/api/_affiliate-auth.ts';
import { database as realDB } from './_db.js';
const allowLimiter = { limit: async () => ({ success: true }) };

const SECRET = 'admin-demo-test-secret';
const fixture = readFileSync(new URL('../../examples/local-demo.sql', import.meta.url), 'utf8');
function setup(t) {
    const { sql, DB } = realDB();
    cleanup(() => sql.close());
    sql.exec(fixture);
    return { sql, env: { DB, ADMIN_TOKEN: SECRET, AFFILIATE_SESSION_SECRET: 'affiliate-secret',
        AFFILIATE_DEV_MODE: 'true', AFFILIATE_PUBLIC_LIMITER: allowLimiter } };
}
function request(path, { host = 'localhost:8787', method = 'GET', headers = {}, body } = {}) {
    const origin = `http://${host}`;
    return new Request(origin + path, { method, headers: {
        ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const send = (path, env, options) => worker.fetch(request(path, options), env, {});
const cookie = response => response.headers.get('Set-Cookie').split(';')[0];

describe('local affiliate demo', () => {
    it('seeds once, preserves changes, and signs into the real affiliate dashboard API', async t => {
        const { sql, env } = setup(t);
        sql.exec("UPDATE conversions SET status='approved' WHERE stripe_session_id='cs_local_demo_pending'");
        sql.exec(fixture);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM affiliates').get().n, 2);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 3);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM conversions').get().n, 3);
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM payouts').get().n, 1);
        const login = await send('/api/affiliate/dev-login', env, { method: 'POST' });
        assert.equal(login.status, 200);
        assert.match(login.headers.get('Set-Cookie'), /HttpOnly/);
        assert.equal(login.headers.get('Cache-Control'), 'no-store');
        const me = await send('/api/affiliate/me', env, { headers: { Cookie: cookie(login) } });
        const data = await me.json();
        assert.equal(data.code, 'local-demo');
        assert.equal(data.email, 'demo@example.test');
        assert.equal(data.clicks, 3);
        assert.equal(data.totals.approved.commission_cents, 2480);
        assert.equal(data.totals.paid.commission_cents, 1800);
    });

    it('blocks all demo routes on deployed hosts, without opt-in, and for foreign origins', async t => {
        const { env } = setup(t);
        for (const [path, method] of [['/api/affiliate/dev', 'GET'], ['/api/affiliate/dev-login', 'POST'], ['/api/admin/dev-login', 'POST']]) {
            assert.equal((await send(path, env, { host: 'holotype.com.sg', method })).status, 404);
            assert.equal((await send(path, { ...env, AFFILIATE_DEV_MODE: undefined }, { method })).status, 404);
            assert.equal((await send(path, env, { host: 'localhost.evil.test', method })).status, 404);
            if (method === 'POST') assert.equal((await send(path, env, { method, headers: { Origin: 'https://evil.test' } })).status, 403);
        }
        assert.equal((await send('/api/affiliate/dev', env, { host: '127.0.0.1:8787' })).status, 200);
        assert.equal((await send('/api/affiliate/dev', env, { host: '[::1]:8787' })).status, 200);
    });

    it('refuses to sign in a missing or suspended demo affiliate', async t => {
        const { env, sql } = setup(t);
        sql.exec("UPDATE affiliates SET status='suspended' WHERE code='local-demo'");
        assert.equal((await send('/api/affiliate/dev-login', env, { method: 'POST' })).status, 503);
        sql.exec('DELETE FROM affiliates');
        assert.equal((await send('/api/affiliate/dev-login', env, { method: 'POST' })).status, 503);
    });

    it('creates and approves demo partners without Stripe or email; blocks payouts', async t => {
        const { env, sql } = setup(t);
        const original = globalThis.fetch;
        globalThis.fetch = async () => { assert.fail('Local demo must not contact Stripe or send email'); };
        cleanup(() => { globalThis.fetch = original; });
        const login = await send('/api/admin/dev-login', env, { method: 'POST' });
        const headers = { Cookie: cookie(login) };
        const created = await send('/api/admin/affiliates', { ...env, BREVO_API_KEY: 'would-send-email' }, {
            method: 'POST', headers, body: { email: 'new@example.test', code: 'new-demo' },
        });
        assert.equal(created.status, 200);
        const id = (await created.json()).affiliate.id;
        assert.equal((await send('/api/admin/affiliate-approve', env, { method: 'POST', headers, body: { id } })).status, 200);
        assert.equal(sql.prepare('SELECT status FROM affiliates WHERE id=?').get(id).status, 'active');
        assert.equal((await send('/api/admin/payouts-run', { ...env, STRIPE_SECRET_KEY: 'sk_live_must_not_be_used' }, { method: 'POST', headers, body: {} })).status, 409);
    });
});

describe('admin browser sessions', () => {
    it('logs in, loads partners/conversions/payouts, reviews a conversion, and logs out', async t => {
        const { env, sql } = setup(t);
        const login = await send('/api/admin/login', env, { method: 'POST', body: { token: SECRET } });
        assert.equal(login.status, 200);
        assert.match(login.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict/);
        assert.ok(!login.headers.get('Set-Cookie').includes(SECRET));
        const headers = { Cookie: cookie(login) };
        for (const path of ['/api/admin/affiliates', '/api/admin/conversions', '/api/admin/payouts']) {
            const response = await send(path, env, { headers });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).ok, true);
        }
        const id = sql.prepare("SELECT id FROM conversions WHERE status='pending'").get().id;
        assert.equal((await send('/api/admin/conversion-approve', env, { method: 'POST', headers, body: { id } })).status, 200);
        assert.equal(sql.prepare('SELECT status FROM conversions WHERE id=?').get(id).status, 'approved');
        const logout = await send('/api/admin/logout', env, { method: 'POST', headers });
        assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
        assert.equal((await send('/api/admin/affiliates', env, { headers: { Cookie: cookie(logout) } })).status, 401);
    });

    it('rejects expired/forged/affiliate sessions, rotated tokens, and missing configuration', async t => {
        const { env } = setup(t);
        const expired = await createAdminSession(SECRET, -1);
        const affiliate = await createSession(1, SECRET);
        const valid = await createAdminSession(SECRET);
        for (const token of [expired, affiliate, valid + 'tampered']) {
            assert.equal((await send('/api/admin/affiliates', env, { headers: { Cookie: `aff_admin_session=${token}` } })).status, 401);
        }
        assert.equal((await send('/api/admin/affiliates', { ...env, ADMIN_TOKEN: 'rotated' }, { headers: { Cookie: `aff_admin_session=${valid}` } })).status, 401);
        assert.equal((await send('/api/admin/dev-login', { ...env, ADMIN_TOKEN: undefined }, { method: 'POST' })).status, 503);
        assert.equal((await send('/api/admin/login', env, { method: 'POST', body: { token: 'wrong' } })).status, 401);
        assert.equal((await send('/api/admin/login', { ...env, AFFILIATE_PUBLIC_LIMITER: { limit: async () => ({ success: false }) } }, { method: 'POST', body: { token: SECRET } })).status, 429);
    });

    it('rejects cross-origin cookie mutations while keeping CLI header authentication', async t => {
        const { env } = setup(t);
        const session = await createAdminSession(SECRET);
        const headers = { Cookie: `aff_admin_session=${session}`, Origin: 'https://evil.test' };
        assert.equal((await send('/api/admin/conversion-approve', env, { method: 'POST', headers, body: { id: 1 } })).status, 403);
        assert.equal((await send('/api/admin/login', env, { method: 'POST', headers, body: { token: SECRET } })).status, 403);
        assert.equal((await send('/api/admin/logout', env, { method: 'POST', headers })).status, 403);
        assert.equal((await send('/api/admin/affiliates', env, { headers: { 'x-admin-token': SECRET } })).status, 200);
    });

    it('serves a public sign-in shell without private data or browser token storage', async t => {
        const { env } = setup(t);
        const response = await send('/admin/affiliates/', env);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
        const html = await response.text();
        assert.ok(!html.includes(SECRET));
        assert.ok(!html.includes('localStorage') && !html.includes('sessionStorage'));
        assert.ok(!html.includes('buyer1@example.test'));
        assert.match(html, /Sign in as demo admin/);
    });
});
