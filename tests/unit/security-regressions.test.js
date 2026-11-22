import { afterEach, describe, expect, it, vi } from 'vitest';
import { database, context } from './_db.js';
import { onRequestPost as apply } from '../../functions/api/affiliate/apply.ts';
import { onRequestPost as affLoginPost, onRequestGet as affLoginGet } from '../../functions/api/affiliate/login.ts';
import { onRequestPost as affLogout } from '../../functions/api/affiliate/logout.ts';
import { onRequestGet as affMe } from '../../functions/api/affiliate/me.ts';
import { onRequestPost as adminLogin } from '../../functions/api/admin/login.ts';
import { onRequestGet as adminAffiliatesGet, onRequestPost as adminAffiliatesPost } from '../../functions/api/admin/affiliates.ts';
import { onRequestPost as adminApprove } from '../../functions/api/admin/affiliate-approve.ts';
import { onRequestPost as adminConversionApprove } from '../../functions/api/admin/conversion-approve.ts';
import { onRequestPost as adminPayoutsRun } from '../../functions/api/admin/payouts-run.ts';
import { createMagicLink, createSession } from '../../functions/api/_affiliate-auth.ts';
import { createAdminSession } from '../../functions/api/_admin-auth.ts';
import { recordConversion } from '../../src/webhook.ts';
import { attachAffiliateAttribution } from '../../src/checkout.ts';
import { applyAffiliateRef } from '../../src/ref.ts';
import { adminDashboard } from '../../src/admin-dashboard.ts';

const dbs = [];
function makeDb() {
    const db = database();
    dbs.push(db.sql);
    return db;
}

const allowLimiter = { limit: async () => ({ success: true }) };
const denyLimiter = { limit: async () => ({ success: false }) };

afterEach(() => {
    for (const sql of dbs.splice(0)) sql.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('public endpoint rate limiting and payload bounds', () => {
    it('enforces AFFILIATE_PUBLIC_LIMITER and 4KB limit on /api/affiliate/apply', async () => {
        const { DB } = makeDb();
        const req = (body, ip = '1.2.3.4') => new Request('https://shop.example/api/affiliate/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });

        expect((await apply({ request: req({ email: 'a@example.com' }), env: { DB } })).status).toBe(503);
        expect((await apply({ request: req({ email: 'a@example.com' }), env: { DB, AFFILIATE_PUBLIC_LIMITER: denyLimiter } })).status).toBe(429);
        expect((await apply({ request: req({ email: 'a@example.com', message: 'x'.repeat(5000) }), env: { DB, AFFILIATE_PUBLIC_LIMITER: allowLimiter } })).status).toBe(400);
    });

    it('accepts a 2000-char message and rejects 2001 chars on /api/affiliate/apply', async () => {
        const { DB } = makeDb();
        const env = { DB, AFFILIATE_PUBLIC_LIMITER: allowLimiter };
        const send = (email, message) => apply({
            request: new Request('https://shop.example/api/affiliate/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, message }),
            }),
            env,
        });

        expect((await send('ok@example.com', 'a'.repeat(2000))).status).toBe(200);
        expect((await send('too-long@example.com', 'a'.repeat(2001))).status).toBe(400);
    });

    it('enforces AFFILIATE_PUBLIC_LIMITER on /api/affiliate/login and swallows email errors', async () => {
        const { sql, DB } = makeDb();
        sql.exec("INSERT INTO affiliates (id,email,code,status,created_at) VALUES (1,'active@example.com','active','active',0)");
        const req = (email) => new Request('https://shop.example/api/affiliate/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });

        const baseEnv = { DB, AFFILIATE_SESSION_SECRET: 'sec', BREVO_API_KEY: 'key' };
        expect((await affLoginPost({ request: req('active@example.com'), env: baseEnv })).status).toBe(503);
        expect((await affLoginPost({ request: req('active@example.com'), env: { ...baseEnv, AFFILIATE_PUBLIC_LIMITER: denyLimiter } })).status).toBe(429);

        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
        expect((await affLoginPost({ request: req('active@example.com'), env: { ...baseEnv, AFFILIATE_PUBLIC_LIMITER: allowLimiter } })).status).toBe(200);
    });

    it('rate-limits /api/admin/login per IP without a shared global key', async () => {
        const keys = [];
        const limiter = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
        const req = new Request('https://shop.example/api/admin/login', {
            method: 'POST',
            headers: { Origin: 'https://shop.example', 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.5' },
            body: JSON.stringify({ token: 'secret' }),
        });
        const res = await adminLogin({ request: req, env: { ADMIN_TOKEN: 'secret', AFFILIATE_PUBLIC_LIMITER: limiter } });
        expect(res.status).toBe(200);
        expect(keys).toEqual(['affiliate:ip:203.0.113.5']);
    });
});

describe('malformed JSON bodies and auth hardening', () => {
    it('returns 400 (not 500) on null JSON body or non-string email/code', async () => {
        const { DB } = makeDb();
        const env = { DB, ADMIN_TOKEN: 'secret', AFFILIATE_SESSION_SECRET: 'sec', BREVO_API_KEY: 'key', AFFILIATE_PUBLIC_LIMITER: allowLimiter };
        const nullReq = (path) => new Request(`https://shop.example${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': 'secret' },
            body: 'null',
        });

        expect((await apply({ request: nullReq('/api/affiliate/apply'), env })).status).toBe(400);
        expect((await affLoginPost({ request: nullReq('/api/affiliate/login'), env })).status).toBe(400);
        expect((await adminAffiliatesPost({ request: nullReq('/api/admin/affiliates'), env })).status).toBe(400);
        expect((await adminApprove({ request: nullReq('/api/admin/affiliate-approve'), env })).status).toBe(400);
        expect((await adminConversionApprove({ request: nullReq('/api/admin/conversion-approve'), env })).status).toBe(400);

        const arrayEmailReq = new Request('https://shop.example/api/admin/affiliates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': 'secret' },
            body: JSON.stringify({ email: ['@'], code: 123 }),
        });
        expect((await adminAffiliatesPost({ request: arrayEmailReq, env })).status).toBe(400);

        // commissionPct: 0 clamps to 1 instead of defaulting to 20
        const zeroPctReq = new Request('https://shop.example/api/admin/affiliates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': 'secret' },
            body: JSON.stringify({ email: 'zero@example.com', code: 'zero', commissionPct: 0 }),
        });
        expect((await adminAffiliatesPost({ request: zeroPctReq, env: { DB, ADMIN_TOKEN: 'secret' } })).status).toBe(200);
    });

    it('rejects magic-link redemption for pending or suspended affiliates', async () => {
        const { sql, DB } = makeDb();
        sql.exec("INSERT INTO affiliates (id,email,code,status,created_at) VALUES (1,'pending@example.com','pend','pending',0)");
        const secret = 'magic-secret';
        const token = await createMagicLink(1, secret);
        const res = await affLoginGet({
            env: { DB, AFFILIATE_SESSION_SECRET: secret },
            request: new Request(`https://shop.example/api/affiliate/login?token=${encodeURIComponent(token)}`),
        });
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toContain('login=failed');
        expect(res.headers.get('Set-Cookie')).toBeNull();
    });

    it('rejects cross-origin affiliate logout with 403', async () => {
        const res = await affLogout({
            request: new Request('https://shop.example/api/affiliate/logout', {
                method: 'POST',
                headers: { Origin: 'https://evil.example' },
            }),
        });
        expect(res.status).toBe(403);
    });

    it('rejects conflicting duplicate session cookies', async () => {
        const { sql, DB } = makeDb();
        sql.exec("INSERT INTO affiliates (id,email,code,status,created_at) VALUES (1,'a@example.com','a','active',0)");
        const affToken = await createSession(1, 'sec');
        const adminToken = await createAdminSession('admin-sec');

        const affRes = await affMe({
            env: { DB, AFFILIATE_SESSION_SECRET: 'sec' },
            request: new Request('https://shop.example/api/affiliate/me', {
                headers: { Cookie: `__Host-aff_session=forged; __Host-aff_session=${affToken}` },
            }),
        });
        expect(affRes.status).toBe(401);

        const adminRes = await adminAffiliatesGet({
            env: { DB, ADMIN_TOKEN: 'admin-sec' },
            request: new Request('https://shop.example/api/admin/affiliates', {
                headers: { Cookie: `__Host-aff_admin_session=forged; __Host-aff_admin_session=${adminToken}` },
            }),
        });
        expect(adminRes.status).toBe(401);
    });
});

describe('webhook, checkout, ref, approval, and CSP fixes', () => {
    it('handles expanded payment_intent, null amount_total, null lineItems, and suspended affiliates in recordConversion', async () => {
        const { sql, DB } = makeDb();
        sql.exec("INSERT INTO affiliates (id,email,code,status,commission_pct,created_at) VALUES (1,'a@example.com','a','active',20,0),(2,'s@example.com','s','suspended',20,0)");
        const env = { DB };

        // Suspended affiliate should not earn new cookie-attributed conversions.
        const suspended = await recordConversion({
            id: 'cs_susp', amount_total: 5000, currency: 'usd', metadata: { affiliate_id: '2' },
        }, { id: 'evt_susp', created: 1000 }, env);
        expect(suspended).toBeNull();

        // Active affiliate with expanded payment_intent, null amount_total, null lineItems.
        const active = await recordConversion({
            id: 'cs_ok', amount_total: null, currency: 'usd', payment_intent: { id: 'pi_expanded' },
            metadata: { affiliate_id: '1' },
        }, { id: 'evt_ok', created: 1000 }, env, null);
        expect(active).not.toBeNull();
        const row = sql.prepare('SELECT payment_intent, amount_cents, commission_cents FROM conversions WHERE stripe_session_id=?').get('cs_ok');
        expect(row).toEqual({ payment_intent: 'pi_expanded', amount_cents: 0, commission_cents: 0 });
    });

    it('clears conflicting allow_promotion_codes and coupon when attaching a promo code', async () => {
        const { sql, DB } = makeDb();
        sql.exec("INSERT INTO affiliates (id,email,code,status,promo_code_id,created_at) VALUES (1,'a@example.com','alice','active','promo_alice',0)");
        const params = new URLSearchParams({ allow_promotion_codes: 'true', 'discounts[0][coupon]': 'old_coupon' });
        await attachAffiliateAttribution(params, new Request('https://shop.example/checkout', {
            headers: { Cookie: 'affiliate_ref=alice' },
        }), { DB });
        expect(params.has('allow_promotion_codes')).toBe(false);
        expect(params.has('discounts[0][coupon]')).toBe(false);
        expect(params.get('discounts[0][promotion_code]')).toBe('promo_alice');
    });

    it('ignores non-GET requests in applyAffiliateRef and sets Cache-Control: private, no-cache', async () => {
        const { sql, DB } = makeDb();
        sql.exec("INSERT INTO affiliates (id,email,code,status,created_at) VALUES (1,'a@example.com','alice','active',0)");
        const respond = vi.fn(async () => new Response('ok', { headers: { 'Cache-Control': 'public, max-age=3600' } }));

        expect(await applyAffiliateRef(new Request('https://shop.example/?ref=alice', { method: 'HEAD' }), { DB }, respond)).toBeNull();
        expect(await applyAffiliateRef(new Request('https://shop.example/?ref=alice', { method: 'POST' }), { DB }, respond)).toBeNull();
        expect(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n).toBe(0);

        const res = await applyAffiliateRef(new Request('https://shop.example/?ref=alice', { method: 'GET' }), { DB }, respond);
        expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
        expect(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n).toBe(1);
    });

    it('does not re-send acceptance email on Connect retry and sends Idempotency-Key', async () => {
        const { sql, DB } = makeDb();
        sql.exec("INSERT INTO affiliates (id,email,code,status,commission_pct,created_at) VALUES (1,'a@example.com','alice','pending',20,0)");
        let connectOk = false;
        const fetchMock = vi.fn(async (url, opts) => {
            if (url.endsWith('/promotion_codes')) {
                expect(opts.headers['Idempotency-Key']).toBeTruthy();
                return Response.json({ id: 'promo_a', code: 'ALICE10' });
            }
            if (url.endsWith('/accounts')) {
                expect(opts.headers['Idempotency-Key']).toBeTruthy();
                return connectOk ? Response.json({ id: 'acct_a' }) : Response.json({ error: { message: 'nope' } }, { status: 400 });
            }
            if (url.endsWith('/account_links')) return Response.json({ url: 'https://connect.example/onboard' });
            return Response.json({});
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const env = { DB, ADMIN_TOKEN: 't', STRIPE_SECRET_KEY: 'sk', BREVO_API_KEY: 'bk' };
        expect((await adminApprove(context(env, '/api/admin/affiliate-approve', { id: 1 }))).status).toBe(200);
        connectOk = true;
        expect((await adminApprove(context(env, '/api/admin/affiliate-approve', { id: 1 }))).status).toBe(200);

        const emails = fetchMock.mock.calls.filter(([url]) => url.includes('brevo'));
        expect(emails).toHaveLength(1);
    });

    it('does not emit null origins into adminDashboard CSP for opaque URLs', () => {
        const res = adminDashboard(
            { request: new Request('https://shop.example/admin/affiliates/') },
            { stylesheets: ['data:text/css,body{}'], fontOrigins: ['javascript:alert(1)'] }
        );
        const csp = res.headers.get('Content-Security-Policy');
        expect(csp).not.toContain(' null');
    });
});
