import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, context } from './_db.js';
import { onRequestPost as payout } from '../../functions/api/admin/payouts-run.ts';
import { onRequestPost as approveConversion } from '../../functions/api/admin/conversion-approve.ts';
import { handleAffiliateApi, recordRefund } from '../../src/index.ts';

let sql, env, fetchMock;
function conversion(id, commission = 2000, status = 'approved') {
    sql.prepare(`INSERT INTO conversions (id,affiliate_id,stripe_session_id,amount_cents,commission_cents,status,created_at,currency)
        VALUES (?,1,?,10000,?,?,0,'usd')`).run(id, `cs_${id}`, commission, status);
}
const run = (body = {}) => payout(context(env, '/api/admin/payouts-run', body));
const reconcile = (id, body = {}) => handleAffiliateApi(context(env, '/api/admin/payouts-reconcile', { id, ...body }).request, env);
const refund = payment_intent => recordRefund({ type: 'charge.refunded', data: { object: { payment_intent } } }, env);
const stripeTransfer = (payout, fields = {}) => ({
    id: 'tr_recovered', amount: payout.amount_cents, currency: payout.currency, destination: 'acct_sam',
    metadata: { affiliate_id: String(payout.affiliate_id), payout_id: String(payout.id) },
    reversed: false, amount_reversed: 0, ...fields,
});
beforeEach(() => {
    const db = database();
    sql = db.sql;
    env = { ADMIN_TOKEN: 'test-admin-token', DB: db.DB, STRIPE_SECRET_KEY: 'test-key' };
    sql.exec("INSERT INTO affiliates (id,email,code,status,stripe_account_id,created_at) VALUES (1,'sam@example.com','sam','active','acct_sam',0)");
    conversion(1);
    fetchMock = vi.fn(async () => Response.json({ id: 'tr_test' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('durable payouts', () => {
    it.each(['http', 'network'])('leaves failed transfers unpaid and resumes their batch: %s', async (failure) => {
        fetchMock.mockImplementationOnce(async () => {
            if (failure === 'network') throw new Error('connection reset');
            return Response.json({ error: { message: 'Insufficient balance' } }, { status: 400 });
        });
        const first = await run();
        expect(first.status).toBe(502);
        expect((await first.json()).ok).toBe(false);
        expect(sql.prepare('SELECT status,paid_at FROM conversions').get()).toMatchObject({ status: 'paying', paid_at: null });
        expect(sql.prepare('SELECT status FROM payouts').get().status).toBe('pending');
        expect((await run()).status).toBe(200);
        const [initial, retry] = fetchMock.mock.calls.map(([, options]) => options);
        expect(retry.headers['Idempotency-Key']).toBe(initial.headers['Idempotency-Key']);
        expect(retry.body.toString()).toBe(initial.body.toString());
        expect(sql.prepare('SELECT COUNT(*) AS n FROM payouts').get().n).toBe(1);
        expect(sql.prepare('SELECT status FROM conversions').get().status).toBe('paid');
    });
    it('assigns different keys to separate batches with the same total', async () => {
        await run();
        conversion(2);
        await run();
        const keys = fetchMock.mock.calls.map(([, options]) => options.headers['Idempotency-Key']);
        expect(new Set(keys).size).toBe(2);
        expect(sql.prepare("SELECT COUNT(*) AS n FROM payouts WHERE status='sent'").get().n).toBe(2);
    });
    it('excludes conversions approved while the transfer is in progress', async () => {
        conversion(2, 1000, 'pending');
        fetchMock.mockImplementationOnce(async (_, options) => {
            expect(options.body.get('amount')).toBe('2000');
            expect((await approveConversion(context(env, '/api/admin/conversion-approve', { id: 2 }))).status).toBe(200);
            // Claimed conversions cannot be reopened by the admin endpoint.
            expect((await approveConversion(context(env, '/api/admin/conversion-approve', { id: 1, approved: false }))).status).toBe(404);
            return Response.json({ id: 'tr_first' });
        });
        await run();
        expect(sql.prepare('SELECT status,payout_id FROM conversions WHERE id=2').get()).toMatchObject({ status: 'approved', payout_id: null });
        expect(sql.prepare("SELECT SUM(commission_cents) AS total FROM conversions WHERE status='paid'").get().total).toBe(2000);
        await run();
        expect(fetchMock.mock.calls[1][1].body.get('amount')).toBe('1000');
    });
    it('retries identical transfer parameters after a successful transfer followed by a DB failure', async () => {
        const original = env.DB.batch.bind(env.DB);
        const batchSpy = vi.spyOn(env.DB, 'batch');
        batchSpy.mockImplementationOnce(original).mockRejectedValueOnce(new Error('DB finalization failed'));
        await expect(run()).rejects.toThrow('DB finalization failed');
        expect(sql.prepare('SELECT status FROM payouts').get().status).toBe('pending');
        sql.exec("UPDATE affiliates SET stripe_account_id='acct_changed'");
        expect((await run()).status).toBe(200);
        const [initial, retry] = fetchMock.mock.calls.map(([, options]) => options);
        expect(retry.body.toString()).toBe(initial.body.toString());
        expect(retry.headers['Idempotency-Key']).toBe(initial.headers['Idempotency-Key']);
    });
    it('shares one batch across overlapping requests and simulates one Stripe money move', async () => {
        const transfers = new Map();
        fetchMock.mockImplementation(async (_, options) => {
            const key = options.headers['Idempotency-Key'];
            if (transfers.has(key)) expect(options.body.toString()).toBe(transfers.get(key));
            else transfers.set(key, options.body.toString());
            await Promise.resolve();
            return Response.json({ id: 'tr_shared' });
        });
        const results = await Promise.all([run(), run()]);
        expect(results.every((response) => response.status === 200)).toBe(true);
        expect(transfers.size).toBe(1);
        expect(sql.prepare('SELECT COUNT(*) AS n FROM payouts').get().n).toBe(1);
        expect(sql.prepare('SELECT status FROM conversions').get().status).toBe('paid');
    });
    it('finalizes manual payouts without calling Stripe', async () => {
        sql.exec('UPDATE affiliates SET stripe_account_id=NULL');
        expect((await run()).status).toBe(200);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(sql.prepare('SELECT status FROM payouts').get().status).toBe('manual');
        expect(sql.prepare('SELECT status FROM conversions').get().status).toBe('paid');
    });
    it('does not resend unresolved transfers after the safe retry window', async () => {
        fetchMock.mockRejectedValueOnce(new Error('connection reset'));
        await run();
        sql.exec('UPDATE payouts SET transfer_started_at=0');
        fetchMock.mockClear();
        const response = await run();
        expect(response.status).toBe(502);
        expect((await response.json()).payouts[0].error).toContain('reconcile');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('blocks payouts until legacy pending rows are reconciled', async () => {
        sql.exec("INSERT INTO payouts (affiliate_id,amount_cents,status,created_at) VALUES (1,2000,'pending',0)");
        const response = await run();
        expect(response.status).toBe(502);
        expect((await response.json()).payouts[0].error).toContain('Legacy');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(sql.prepare('SELECT status FROM conversions').get().status).toBe('approved');
    });
    it('rolls back the entire claim if conversion assignment fails', async () => {
        sql.exec("CREATE TRIGGER fail_claim BEFORE UPDATE OF payout_id ON conversions BEGIN SELECT RAISE(ABORT, 'claim failed'); END");
        await expect(run()).rejects.toThrow('claim failed');
        expect(sql.prepare('SELECT COUNT(*) AS n FROM payouts').get().n).toBe(0);
        expect(sql.prepare('SELECT status,payout_id FROM conversions').get()).toMatchObject({ status: 'approved', payout_id: null });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('returns 404 when there is nothing to pay', async () => {
        sql.exec("UPDATE conversions SET status='pending'");
        expect((await run()).status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('payout reconciliation', () => {
    it('finalizes a verified Stripe transfer across pages without resending', async () => {
        fetchMock.mockRejectedValueOnce(new Error('connection reset'));
        await run();
        const payout = sql.prepare('SELECT * FROM payouts').get();
        fetchMock
            .mockResolvedValueOnce(Response.json({ data: [{ id: 'tr_other' }], has_more: true }))
            .mockResolvedValueOnce(Response.json({ data: [stripeTransfer(payout)], has_more: false }));
        expect(await (await reconcile(payout.id)).json()).toMatchObject({ status: 'sent', stripe_transfer_id: 'tr_recovered' });
        const searches = fetchMock.mock.calls.slice(1).map(([url, options]) => {
            expect(options.method).toBe('GET');
            return new URL(url).searchParams;
        });
        expect(searches[0].get('transfer_group')).toBe('affiliate_payout_1');
        expect(searches[1].get('starting_after')).toBe('tr_other');
        expect(sql.prepare('SELECT status FROM conversions WHERE id=1').get().status).toBe('paid');
        expect((await reconcile(payout.id)).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('blocks a possibly sent refund batch and releases only the unpaid eligible commissions after expiration', async () => {
        conversion(2, 1000);
        sql.exec("UPDATE conversions SET payment_intent='pi_refunded' WHERE id=1");
        fetchMock.mockImplementationOnce(async () => {
            await refund('pi_refunded');
            throw new Error('connection reset');
        });
        expect((await run()).status).toBe(502);
        expect((await run()).status).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const payout = sql.prepare('SELECT * FROM payouts').get();
        fetchMock.mockImplementation(async () => Response.json({ data: [], has_more: false }));
        expect((await reconcile(payout.id, { action: 'release' })).status).toBe(409);
        sql.exec('UPDATE payouts SET transfer_started_at=0');
        expect(await (await reconcile(payout.id)).json()).toMatchObject({ status: 'pending', can_release: true });
        expect(await (await reconcile(payout.id, { action: 'release' })).json()).toMatchObject({ status: 'failed' });
        expect(sql.prepare('SELECT status,payout_id FROM conversions ORDER BY id').all()).toEqual([
            { status: 'refunded', payout_id: null }, { status: 'approved', payout_id: null },
        ]);
    });

    it('drops a refund from an unattempted batch before sending a replacement', async () => {
        sql.exec("INSERT INTO payouts (id,affiliate_id,amount_cents,status,created_at,batch_key,stripe_account_id) VALUES (1,1,2000,'pending',0,'old','acct_sam')");
        sql.exec("UPDATE conversions SET payment_intent='pi_refunded', status='paying', payout_id=1");
        await refund('pi_refunded');
        conversion(2, 1000);
        expect((await run()).status).toBe(502);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(sql.prepare('SELECT status FROM payouts WHERE id=1').get().status).toBe('failed');
        expect((await run()).status).toBe(200);
        expect(fetchMock.mock.calls[0][1].body.get('amount')).toBe('1000');
    });

    it('requires a valid original conversion set to finalize a matching legacy transfer', async () => {
        sql.exec("INSERT INTO payouts (affiliate_id,amount_cents,status,created_at) VALUES (1,2500,'pending',0)");
        conversion(2, 500);
        conversion(3, 2500, 'pending');
        const payout = sql.prepare('SELECT * FROM payouts').get();
        fetchMock.mockImplementation(async () => Response.json({
            data: [stripeTransfer(payout)], has_more: false,
        }));
        expect((await reconcile(payout.id)).status).toBe(409);
        expect((await reconcile(payout.id, { conversionIds: [3] })).status).toBe(409);
        expect((await reconcile(payout.id, { conversionIds: [1, 2] })).status).toBe(200);
        expect(sql.prepare('SELECT status,payout_id FROM conversions ORDER BY id').all()).toEqual([
            { status: 'paid', payout_id: payout.id }, { status: 'paid', payout_id: payout.id }, { status: 'pending', payout_id: null },
        ]);
    });

    it('never releases a batch with a mismatched or reversed transfer', async () => {
        fetchMock.mockRejectedValueOnce(new Error('connection reset'));
        await run();
        sql.exec('UPDATE payouts SET transfer_started_at=0');
        const payout = sql.prepare('SELECT * FROM payouts').get();
        fetchMock.mockResolvedValueOnce(Response.json({
            data: [stripeTransfer(payout, { reversed: true, amount_reversed: 2000 })], has_more: false,
        }));
        expect((await reconcile(payout.id, { action: 'release' })).status).toBe(409);
        expect(sql.prepare('SELECT status FROM payouts').get().status).toBe('pending');
        expect(sql.prepare('SELECT status FROM conversions').get().status).toBe('paying');
    });
});
