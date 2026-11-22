import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, context } from './_db.js';
import { onRequestPost as payout } from '../../functions/api/admin/payouts-run.js';

let sql, env, stripe;
const run = () => payout(context(env, '/api/admin/payouts-run', {}));

function conversion(id, currency, commission, paymentIntent = 'pi_' + id) {
    sql.prepare(`INSERT INTO conversions (id,affiliate_id,stripe_session_id,payment_intent,amount_cents,commission_cents,status,created_at,currency)
        VALUES (?,1,?,?,?,?,'approved',0,?)`).run(id, 'cs_' + id, paymentIntent, commission * 5, commission, currency);
}

// What Stripe returns for a settled charge: the sale amount in its own
// currency, and the balance transaction in the platform's currency.
function settledCharge(saleCurrency, saleAmount, platformCurrency, platformAmount, txn = 'txn_1') {
    return { id: 'pi', latest_charge: { amount: saleAmount, currency: saleCurrency,
        balance_transaction: { id: txn, amount: platformAmount, currency: platformCurrency } } };
}

beforeEach(() => {
    const db = database();
    sql = db.sql;
    env = { ADMIN_TOKEN: 'admin', DB: db.DB, STRIPE_SECRET_KEY: 'sk_test' };
    sql.exec("INSERT INTO affiliates (id,email,code,status,stripe_account_id,created_at) VALUES (1,'sam@example.com','sam','active','acct_sam',0)");
    stripe = { charges: {} };
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
        const path = new URL(url).pathname;
        if (path.startsWith('/v1/payment_intents/')) {
            const charge = stripe.charges[decodeURIComponent(path.split('/')[3])];
            return charge ? Response.json(charge) : Response.json({ error: { message: 'No such payment_intent' } }, { status: 404 });
        }
        if (path === '/v1/transfers') {
            stripe.transfer = Object.fromEntries(options.body);
            return Response.json({ id: 'tr_1' });
        }
        throw new Error('unexpected Stripe call ' + url);
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('payouts in the platform currency', () => {
    it('still pays USD commissions in USD by default', async () => {
        conversion(1, 'usd', 2000);
        expect((await run()).status).toBe(200);
        expect(stripe.transfer).toMatchObject({ amount: '2000', currency: 'usd' });
    });

    it('converts other currencies at the rate Stripe settled each sale at, and records where it came from', async () => {
        conversion(1, 'usd', 2000);
        conversion(2, 'aud', 1000);            // AUD sale of 50.00, commission 10.00
        conversion(3, 'jpy', 1000);            // JPY sale of ¥5000, commission ¥1000
        stripe.charges.pi_2 = settledCharge('aud', 5000, 'usd', 3300, 'txn_aud');
        stripe.charges.pi_3 = settledCharge('jpy', 5000, 'usd', 3350, 'txn_jpy');
        expect((await run()).status).toBe(200);
        // 2000 + 1000 × 3300/5000 + 1000 × 3350/5000 = 2000 + 660 + 670
        expect(stripe.transfer).toMatchObject({ amount: '3330', currency: 'usd', destination: 'acct_sam' });
        const rows = sql.prepare('SELECT id, payout_cents, payout_currency, fx_source, status FROM conversions ORDER BY id').all().map(r => ({ ...r }));
        expect(rows).toEqual([
            { id: 1, payout_cents: 2000, payout_currency: 'usd', fx_source: null, status: 'paid' },
            { id: 2, payout_cents: 660, payout_currency: 'usd', fx_source: 'txn_aud', status: 'paid' },
            { id: 3, payout_cents: 670, payout_currency: 'usd', fx_source: 'txn_jpy', status: 'paid' },
        ]);
        expect(sql.prepare('SELECT amount_cents, currency FROM payouts').get()).toEqual({ amount_cents: 3330, currency: 'usd' });
    });

    it('pays in the platform currency set by AFFILIATE_PAYOUT_CURRENCY', async () => {
        env.AFFILIATE_PAYOUT_CURRENCY = 'AUD';
        conversion(1, 'aud', 1500);
        conversion(2, 'usd', 1000);
        stripe.charges.pi_2 = settledCharge('usd', 5000, 'aud', 7600);
        expect((await run()).status).toBe(200);
        expect(stripe.transfer).toMatchObject({ amount: '3020', currency: 'aud' });
    });

    it('blocks the run when a commission can\'t be converted, and pays nothing', async () => {
        conversion(1, 'usd', 2000);
        conversion(2, 'eur', 1000);                       // Stripe has no settled charge for it
        conversion(3, 'gbp', 1000, null);                 // no payment intent at all
        const res = await run();
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/could not be converted to USD/);
        expect(stripe.transfer).toBeUndefined();
        // A settlement in a different platform currency isn't guessed at either.
        stripe.charges.pi_2 = settledCharge('eur', 5000, 'gbp', 4300);
        expect((await run()).status).toBe(409);
        expect(sql.prepare('SELECT COUNT(*) AS n FROM payouts').get().n).toBe(0);
    });

    it('rejects a malformed payout currency', async () => {
        env.AFFILIATE_PAYOUT_CURRENCY = 'dollars';
        conversion(1, 'usd', 2000);
        expect((await run()).status).toBe(500);
    });
});
