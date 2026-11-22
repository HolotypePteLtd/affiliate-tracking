import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { releaseHeldConversions } from '../../src/index.js';
import { onRequestPost as reviewPost } from '../../functions/api/admin/affiliate-review.js';
import { database, context } from './_db.js';

const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-30T00:00:00Z');

function setup() {
    const { sql, DB } = database();
    cleanups.push(() => sql.close());
    sql.exec(`INSERT INTO affiliates (id,email,code,status,created_at) VALUES
        (1,'a@example.test','a','active',0),
        (2,'b@example.test','b','suspended',0),
        (3,'c@example.test','c','active',0)`);
    const insert = sql.prepare(`INSERT INTO conversions
        (id,affiliate_id,stripe_session_id,payment_intent,amount_cents,commission_cents,status,created_at)
        VALUES (?,?,?,?,1000,200,?,?)`);
    const add = (id, affiliateId, ageDays, status = 'pending', pi = 'pi_' + id) =>
        insert.run(id, affiliateId, 'cs_' + id, pi, status, NOW - ageDays * DAY);
    const status = id => sql.prepare('SELECT status, approved_at FROM conversions WHERE id=?').get(id);
    return { sql, DB, add, status };
}

describe('automatic hold period', () => {
    it('does nothing when AFFILIATE_HOLD_DAYS is unset', async () => {
        const { DB, add, status } = setup();
        add(1, 1, 90);
        assert.equal(await releaseHeldConversions({ DB }, NOW), 0);
        assert.equal(status(1).status, 'pending');
    });

    it('approves pending conversions once they are at least the hold period old', async () => {
        const { DB, add, status } = setup();
        add(1, 1, 30);
        add(2, 1, 29);
        const env = { DB, AFFILIATE_HOLD_DAYS: '30' };
        assert.equal(await releaseHeldConversions(env, NOW), 1);
        assert.deepEqual({ ...status(1) }, { status: 'approved', approved_at: NOW });
        assert.equal(status(2).status, 'pending');
        // The 29-day one is released a day later, and nothing is released twice.
        assert.equal(await releaseHeldConversions(env, NOW + DAY), 1);
        assert.equal(await releaseHeldConversions(env, NOW + DAY), 0);
        assert.equal(status(1).approved_at, NOW);
    });

    it('never releases refunded, disputed, suspended or review-required conversions', async () => {
        const { sql, DB, add, status } = setup();
        add(1, 1, 40, 'refunded');
        add(2, 2, 40);                       // suspended affiliate
        add(3, 3, 40);                       // affiliate flagged for review
        add(4, 1, 40, 'pending', 'pi_late'); // refund marker arrived before the conversion
        add(5, 1, 40, 'paid');
        sql.exec("UPDATE affiliates SET review_required=1 WHERE id=3");
        sql.exec("INSERT INTO refunded_payments (payment_intent) VALUES ('pi_late')");
        assert.equal(await releaseHeldConversions({ DB, AFFILIATE_HOLD_DAYS: '30' }, NOW), 0);
        assert.deepEqual([1, 2, 3, 4, 5].map(id => status(id).status),
            ['refunded', 'pending', 'pending', 'pending', 'paid']);
    });

    it('rejects a malformed hold period instead of guessing', async () => {
        const { DB } = setup();
        for (const value of ['thirty', '-1', '1.5', '99999']) {
            await assert.rejects(releaseHeldConversions({ DB, AFFILIATE_HOLD_DAYS: value }, NOW), /AFFILIATE_HOLD_DAYS/);
        }
    });

    it('lets an admin flag an affiliate for manual review', async () => {
        const { sql, DB, add, status } = setup();
        add(1, 1, 40);
        const env = { DB, ADMIN_TOKEN: 'admin-token' };
        const res = await reviewPost(context(env, '/api/admin/affiliate-review', { id: 1, review_required: true }));
        assert.equal(res.status, 200);
        assert.equal(sql.prepare('SELECT review_required FROM affiliates WHERE id=1').get().review_required, 1);
        assert.equal(await releaseHeldConversions({ DB, AFFILIATE_HOLD_DAYS: '30' }, NOW), 0);
        assert.equal(status(1).status, 'pending');

        assert.equal((await reviewPost(context(env, '/api/admin/affiliate-review', { id: 1, review_required: 'yes' }))).status, 400);
        assert.equal((await reviewPost(context(env, '/api/admin/affiliate-review', { id: 99, review_required: false }))).status, 404);
        const wrongToken = context(env, '/api/admin/affiliate-review', { id: 1, review_required: false });
        wrongToken.request.headers.set('x-admin-token', 'wrong');
        assert.equal((await reviewPost(wrongToken)).status, 401);
    });
});
