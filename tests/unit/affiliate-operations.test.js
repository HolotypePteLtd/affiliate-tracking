import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyAffiliateRef, handleAffiliateApi, recordConversion, recordRefund } from '../../src/index.ts';
import { createMagicLink } from '../../functions/api/_affiliate-auth.ts';
import { createAdminSession } from '../../functions/api/_admin-auth.ts';
import { context, database } from './_db.js';

let sql, env;

beforeEach(() => {
    const { DB, sql: sqlite } = database();
    sql = sqlite;
    env = { DB, STRIPE_SECRET_KEY: 'stripe-test', ADMIN_TOKEN: 'admin-test', AFFILIATE_SESSION_SECRET: 'affiliate-test' };
    sql.exec(`INSERT INTO affiliates (id,email,code,status,promo_code_id,stripe_account_id,created_at)
        VALUES (1,'alice@example.com','my-code','active','promo_alice','acct_alice',0),
               (2,'bob@example.com','my_code','pending',NULL,NULL,0)`);
});
afterEach(() => { sql.close(); vi.unstubAllGlobals(); });

const admin = (route, body) => handleAffiliateApi(context(env, '/api/admin/' + route, body).request, env);
const get = (path, cookie) => handleAffiliateApi(new Request('https://shop.example' + path,
    { headers: cookie ? { Cookie: cookie } : {} }), env);
const redeem = token => get('/api/affiliate/login?token=' + encodeURIComponent(token));
const magicLink = version => createMagicLink(1, env.AFFILIATE_SESSION_SECRET, version);
const cookieFrom = response => response.headers.get('Set-Cookie')?.split(';')[0];

it('redeems a magic link once and revokes prior sessions and unredeemed links', async () => {
    const [token, unusedToken] = await Promise.all([magicLink(), magicLink()]);
    const attempts = await Promise.all([redeem(token), redeem(token)]);
    expect(attempts.map(cookieFrom).filter(Boolean)).toHaveLength(1);
    const cookie = attempts.map(cookieFrom).find(Boolean);
    expect(cookie).toMatch(/^__Host-aff_session=/);
    expect((await get('/api/affiliate/me', cookie)).status).toBe(200);
    expect((await get('/api/affiliate/me', cookie.slice('__Host-'.length))).status).toBe(401);
    expect((await admin('affiliate-revoke-sessions', { id: 1 })).status).toBe(200);
    expect((await get('/api/affiliate/me', cookie)).status).toBe(401);
    expect(cookieFrom(await redeem(unusedToken))).toBeUndefined();
    expect(cookieFrom(await redeem(await magicLink(1)))).toMatch(/^__Host-aff_session=/);
    expect(sql.prepare('SELECT status FROM affiliates WHERE id=1').get().status).toBe('active');
});

it('accepts only the host-prefixed admin session cookie on HTTPS', async () => {
    const token = await createAdminSession(env.ADMIN_TOKEN);
    expect((await get('/api/admin/affiliates', 'aff_admin_session=' + token)).status).toBe(401);
    expect((await get('/api/admin/affiliates', '__Host-aff_admin_session=' + token)).status).toBe(200);
});

it('resumes an ambiguous suspension and reactivates Stripe with a new operation', async () => {
    const cookie = cookieFrom(await redeem(await magicLink()));
    const fetchMock = vi.fn(async (_, request) => Response.json({ active: request.body.get('active') === 'true' }));
    fetchMock.mockRejectedValueOnce(new Error('timed out'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await admin('affiliate-status', { id: 1, status: 'suspended' })).status).toBe(502);
    expect((await get('/api/affiliate/me', cookie)).status).toBe(401);
    expect((await admin('affiliate-status', { id: 1, status: 'active' })).status).toBe(409);
    expect((await admin('affiliate-status', { id: 1, status: 'suspended' })).status).toBe(200);
    expect((await admin('affiliate-status', { id: 1, status: 'active' })).status).toBe(200);
    expect((await get('/api/affiliate/me', cookie)).status).toBe(401);
    const [first, retry, reactivation] = fetchMock.mock.calls.map(([url, request]) => {
        expect(url).toBe('https://api.stripe.com/v1/promotion_codes/promo_alice');
        return request;
    });
    expect(first.headers['Idempotency-Key']).toBe(retry.headers['Idempotency-Key']);
    expect(reactivation.headers['Idempotency-Key']).not.toBe(retry.headers['Idempotency-Key']);
    expect([first, retry, reactivation].map(r => r.body.get('active'))).toEqual(['false', 'false', 'true']);
    expect(sql.prepare('SELECT status,session_version FROM affiliates WHERE id=1').get()).toMatchObject({
        status: 'active', session_version: 1,
    });
});

it('creates fresh onboarding links only for a signed-in affiliate’s own Connect account', async () => {
    const path = '/api/affiliate/connect-onboarding';
    const cookie = cookieFrom(await redeem(await magicLink()));
    const fetchMock = vi.fn(async () => Response.json({ url: `https://connect.stripe.com/setup/${fetchMock.mock.calls.length}` }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await get(path)).headers.get('Location')).toBe('https://shop.example/affiliates/');
    const first = await get(path + '?account=acct_someone_else', cookie);
    const second = await get(path, cookie);
    expect(first.status).toBe(303);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(first.headers.get('Location')).not.toBe(second.headers.get('Location'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const form = fetchMock.mock.calls[0][1].body;
    expect(form.get('account')).toBe('acct_alice');
    expect(form.get('refresh_url')).toBe('https://shop.example' + path);
    expect(form.get('return_url')).toBe('https://shop.example/affiliates/dashboard/');
});

it('tries a deterministic alternative when two referral slugs normalize to one Stripe code', async () => {
    const attempts = [];
    vi.stubGlobal('fetch', async (url, request) => {
        if (url.endsWith('/accounts')) return Response.json({ error: { message: 'Connect unavailable' } }, { status: 400 });
        const code = request.body.get('code');
        attempts.push([code, request.headers['Idempotency-Key']]);
        if (code === 'MYCODE10') {
            return Response.json({ error: { code: 'resource_already_exists', param: 'code' } }, { status: 400 });
        }
        return Response.json({ id: 'promo_bob', code });
    });
    expect(await (await admin('affiliate-approve', { id: 2 })).json()).toMatchObject({
        ok: true, promo_code_id: 'promo_bob', promo_code: 'MYCODE10X2',
    });
    expect(attempts.map(([code]) => code)).toEqual(['MYCODE10', 'MYCODE10X2']);
    expect(attempts[0][1]).not.toBe(attempts[1][1]);
    expect(await (await admin('affiliate-approve', { id: 2 })).json()).toMatchObject({ promo_code: 'MYCODE10X2' });
    expect(attempts).toHaveLength(2);
});

it('reserves suspended partners’ codes while Stripe considers them inactive', async () => {
    sql.exec("UPDATE affiliates SET status='suspended', promo_code='MYCODE10' WHERE id=1");
    const fetchMock = vi.fn(async (url, request) => {
        if (url.endsWith('/accounts')) return Response.json({ id: 'acct_bob' });
        if (url.endsWith('/account_links')) return Response.json({ url: 'https://connect.stripe.com/setup/bob' });
        return Response.json({ id: 'promo_bob', code: request.body.get('code') });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await (await admin('affiliate-approve', { id: 2 })).json()).toMatchObject({ promo_code: 'MYCODE10X2' });
    expect(fetchMock.mock.calls[0][1].body.get('code')).toBe('MYCODE10X2');
});

it('records both webhook types idempotently even when a refund arrives before checkout', async () => {
    const checkout = (id, intent) => recordConversion({
        id, payment_intent: intent, metadata: { affiliate_id: '1' }, amount_total: 1000, currency: 'usd',
    }, {}, env);
    const refund = { type: 'charge.refunded', data: { object: { payment_intent: { id: 'pi_early' } } } };
    expect(await recordRefund(refund, env)).toBe(0);
    await checkout('cs_late', 'pi_early');
    await checkout('cs_dispute', 'pi_dispute');
    await checkout('cs_paid', 'pi_dispute');
    sql.exec("UPDATE conversions SET status='approved' WHERE stripe_session_id='cs_dispute'");
    sql.exec("UPDATE conversions SET status='paid' WHERE stripe_session_id='cs_paid'");
    const dispute = { type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_dispute' } } };
    expect(await recordRefund(dispute, env)).toBe(1);
    expect(await recordRefund(dispute, env)).toBe(0);
    expect((await admin('conversion-approve', { id: 2 })).status).toBe(404);
    expect(sql.prepare('SELECT status FROM conversions ORDER BY id').all().map(row => row.status))
        .toEqual(['refunded', 'refunded', 'paid']);
});

it('schedules click recording without waiting for the D1 write', async () => {
    const prepare = env.DB.prepare.bind(env.DB);
    let releaseInsert;
    const beforeInsert = new Promise(resolve => { releaseInsert = resolve; });
    const db = { prepare(query) {
        const statement = prepare(query);
        if (!query.startsWith('INSERT INTO clicks')) return statement;
        const run = statement.run;
        statement.run = async () => { await beforeInsert; return run(); };
        return statement;
    } };
    const ctx = { waitUntil(promise) { this.background = promise; } };
    const response = await applyAffiliateRef(new Request('https://shop.example/?ref=my-code'),
        { DB: db }, () => new Response('storefront'), ctx);
    expect(await response.text()).toBe('storefront');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n).toBe(0);
    releaseInsert();
    await ctx.background;
    expect(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n).toBe(1);
});
