import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, context } from './_db.js';
import { onRequestPost as apply } from '../../functions/api/affiliate/apply.js';
import { onRequestPost as approve } from '../../functions/api/admin/affiliate-approve.js';
import { applyAffiliateRef } from '../../src/ref.js';

let sql, env, fetchMock;
beforeEach(() => {
    const db = database();
    sql = db.sql;
    env = { DB: db.DB, STRIPE_SECRET_KEY: 'test-key', BREVO_API_KEY: 'test-email-key' };
    fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const application = (body) => apply(context(env, '/api/affiliate/apply', body));

describe('applications', () => {
    it('keeps distinct emails with colliding slugs and suppresses only duplicate emails', async () => {
        for (const email of ['sam@one.com', 'sam@two.com', 'SAM@ONE.COM']) {
            expect((await application({ email })).status).toBe(200);
        }
        const rows = sql.prepare('SELECT email, code FROM affiliates').all();
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.code)).size).toBe(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('sends the application content with escaped user input', async () => {
        await application({ email: 'sam@one.com', name: '<b>Sam</b>', message: 'Hello\nWorld' });
        const mail = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(mail.htmlContent).toContain('sam@one.com');
        expect(mail.htmlContent).toContain('&lt;b&gt;Sam&lt;/b&gt;');
        expect(mail.htmlContent).toContain('Hello<br>World');
    });
    it.each(['network', 'http'])('returns success after saving when notification fails: %s', async (failure) => {
        fetchMock.mockImplementation(async () => {
            if (failure === 'network') throw new Error('network failure');
            return Response.json({ error: 'bad sender' }, { status: 400 });
        });
        expect((await application({ email: 'sam@one.com' })).status).toBe(200);
        expect(sql.prepare('SELECT COUNT(*) AS n FROM affiliates').get().n).toBe(1);
        expect(console.error).toHaveBeenCalled();
    });
});

describe('approval', () => {
    it('omits the invalid redemption limit and reuses the promo on a Connect retry', async () => {
        sql.exec("INSERT INTO affiliates (email,code,status,commission_pct,created_at) VALUES ('sam@one.com','sam','pending',35,0)");
        let connectSucceeds = false;
        fetchMock.mockImplementation(async (url, options) => {
            if (url.endsWith('/promotion_codes')) {
                expect(options.body.has('max_redemptions')).toBe(false);
                return Response.json({ id: 'promo_sam', code: 'SAM10' });
            }
            if (url.endsWith('/accounts')) return connectSucceeds
                ? Response.json({ id: 'acct_sam' }) : Response.json({ error: { message: 'Connect unavailable' } }, { status: 400 });
            if (url.endsWith('/account_links')) return Response.json({ url: 'https://connect.example/onboarding' });
            return Response.json({});
        });
        const run = () => approve(context(env, '/api/admin/affiliate-approve', { id: 1 }));
        expect((await run()).status).toBe(200);
        expect(sql.prepare('SELECT promo_code_id,status FROM affiliates').get()).toMatchObject({ promo_code_id: 'promo_sam', status: 'active' });
        connectSucceeds = true;
        expect((await run()).status).toBe(200);
        expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/promotion_codes'))).toHaveLength(1);
        expect(sql.prepare('SELECT stripe_account_id FROM affiliates').get().stripe_account_id).toBe('acct_sam');
        const mail = JSON.parse(fetchMock.mock.calls.find(([url]) => url.includes('brevo'))[1].body);
        expect(mail.htmlContent).toContain('35%');
    });
});

describe('referral middleware', () => {
    it('allows the caller to serve a page after a failed DB lookup', async () => {
        env.DB = { prepare() { throw new Error('D1 unavailable'); } };
        const respond = vi.fn(async () => new Response('page'));
        const request = new Request('https://shop.example/?ref=sam');
        expect(await applyAffiliateRef(request, env, respond)).toBeNull();
        expect(respond).not.toHaveBeenCalled();
        expect(await (await respond()).text()).toBe('page');
    });
    it('sets attribution and records a click for a valid referral', async () => {
        sql.exec("INSERT INTO affiliates (email,code,status,created_at) VALUES ('sam@one.com','sam','active',0)");
        const response = await applyAffiliateRef(new Request('https://shop.example/?ref=sam'), env, async () => new Response('page'));
        expect(response.headers.get('Set-Cookie')).toContain('affiliate_ref=sam');
        expect(sql.prepare('SELECT COUNT(*) AS n FROM clicks').get().n).toBe(1);
    });
});
