import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, context } from './_db.js';
import { onRequestPost as payout } from '../../functions/api/admin/payouts-run.js';
import { onRequestPost as approveConversion } from '../../functions/api/admin/conversion-approve.js';

let sql, env, fetchMock;
function conversion(id, commission = 2000, status = 'approved') {
    sql.prepare(`INSERT INTO conversions (id,affiliate_id,stripe_session_id,amount_cents,commission_cents,status,created_at)
        VALUES (?,1,?,10000,?,?,0)`).run(id, `cs_${id}`, commission, status);
}
const run = (body = {}) => payout(context(env, '/api/admin/payouts-run', body));
beforeEach(() => {
    const db = database();
    sql = db.sql;
    env = { DB: db.DB, STRIPE_SECRET_KEY: 'test-key' };
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
