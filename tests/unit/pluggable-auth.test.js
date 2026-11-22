import { describe, it, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { handleAffiliateApi } from '../../src/route.js';
import { createSession } from '../../functions/api/_affiliate-auth.js';
import { database } from './_db.js';

const cleanups = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) fn(); });

const SITE = 'https://shop.example';

// Stands in for the host's auth (e.g. Better Auth's getSession): a header
// names the signed-in user.
const USERS = {
    u_nick: { id: 'u_nick', email: 'Nick@Example.test', emailVerified: true, role: 'user' },
    u_admin: { id: 'u_admin', email: 'boss@example.test', emailVerified: true, role: 'admin' },
    u_stranger: { id: 'u_stranger', email: 'stranger@example.test', emailVerified: true, role: 'user' },
    u_unverified: { id: 'u_unverified', email: 'bob@example.test', emailVerified: false, role: 'user' },
};
const auth = {
    affiliate: async request => {
        const user = USERS[request.headers.get('x-test-user')];
        return user ? { userId: user.id, email: user.emailVerified ? user.email : null } : null;
    },
    admin: async request => USERS[request.headers.get('x-test-user')]?.role === 'admin',
};

function setup(env = {}) {
    const { sql, DB } = database();
    cleanups.push(() => sql.close());
    sql.exec(`INSERT INTO affiliates (id,email,code,status,created_at) VALUES
        (1,'nick@example.test','nick','active',0),(2,'bob@example.test','bob','active',0),(3,'old@example.test','old','suspended',0)`);
    const fullEnv = { DB, ...env };
    const call = (path, { user, method = 'GET', body, headers = {}, options = { auth } } = {}) => handleAffiliateApi(new Request(SITE + path, {
        method, body: body && JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Origin: SITE, ...(user ? { 'x-test-user': user } : {}), ...headers },
    }), fullEnv, undefined, options);
    return { sql, call, env: fullEnv };
}

describe('pluggable partner sign-in', () => {
    it('signs a partner in through the host auth, matching by email the first time, then by user id', async () => {
        const { sql, call } = setup();
        const res = await call('/api/affiliate/me', { user: 'u_nick' });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).code, 'nick');
        assert.equal(sql.prepare('SELECT user_id FROM affiliates WHERE id=1').get().user_id, 'u_nick');
        // Even if the partner changes their email in the host's auth.
        USERS.u_nick.email = 'new-address@example.test';
        assert.equal((await call('/api/affiliate/me', { user: 'u_nick' })).status, 200);
        USERS.u_nick.email = 'Nick@Example.test';
    });

    it('refuses users who aren\'t affiliates, unverified emails, and suspended affiliates', async () => {
        const { sql, call } = setup();
        assert.equal((await call('/api/affiliate/me', { user: 'u_stranger' })).status, 401);
        assert.equal((await call('/api/affiliate/me', { user: 'u_unverified' })).status, 401);
        assert.equal(sql.prepare('SELECT user_id FROM affiliates WHERE id=2').get().user_id, null);
        assert.equal((await call('/api/affiliate/me')).status, 401);
        sql.exec("UPDATE affiliates SET user_id='u_nick', status='suspended' WHERE id=1");
        assert.equal((await call('/api/affiliate/me', { user: 'u_nick' })).status, 401);
    });

    it('keeps magic-link sessions working alongside', async () => {
        const { call } = setup({ AFFILIATE_SESSION_SECRET: 'secret' });
        const cookie = '__Host-aff_session=' + await createSession(2, 'secret');
        const res = await call('/api/affiliate/me', { headers: { Cookie: cookie } });
        assert.equal((await res.json()).code, 'bob');
    });

    it('answers 503 when the host auth throws, without leaking the error', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { call } = setup();
        const broken = { affiliate: async () => { throw new Error('db down: secret detail'); } };
        const res = await call('/api/affiliate/me', { user: 'u_nick', options: { auth: broken } });
        assert.equal(res.status, 503);
        assert.doesNotMatch(await res.text(), /secret detail/);
    });
});

describe('pluggable admin sign-in', () => {
    it('lets host admins use the admin API without ADMIN_TOKEN', async () => {
        const { call } = setup();
        assert.equal((await call('/api/admin/affiliates', { user: 'u_admin' })).status, 200);
        assert.equal((await call('/api/admin/affiliates', { user: 'u_nick' })).status, 401);
        assert.equal((await call('/api/admin/affiliates')).status, 401);
        const approve = await call('/api/admin/conversion-approve', { user: 'u_admin', method: 'POST', body: { id: 99 } });
        assert.equal(approve.status, 404);
        const crossSite = await call('/api/admin/conversion-approve', { user: 'u_admin', method: 'POST', body: { id: 99 }, headers: { Origin: 'https://evil.example' } });
        assert.equal(crossSite.status, 403);
    });

    it('still accepts the x-admin-token header for scripts', async () => {
        const { call } = setup({ ADMIN_TOKEN: 'token' });
        assert.equal((await call('/api/admin/affiliates', { headers: { 'x-admin-token': 'token' } })).status, 200);
        assert.equal((await call('/api/admin/affiliates', { headers: { 'x-admin-token': 'wrong' } })).status, 401);
    });

    it('behaves exactly as before without auth options', async () => {
        const { call } = setup();
        assert.equal((await call('/api/admin/affiliates', { user: 'u_admin', options: {} })).status, 503);
        await assert.rejects(call('/api/admin/affiliates', { options: { auth: { admin: 'yes' } } }), TypeError);
    });
});
