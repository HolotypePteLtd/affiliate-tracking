import { describe, it, afterEach } from 'vitest';
const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
import assert from 'node:assert/strict';
import { onRequestGet } from '../../functions/api/affiliate/me.ts';
import { createSession } from '../../functions/api/_affiliate-auth.ts';
import { database as realDB } from './_db.js';

async function setup(t) {
    const { sql, DB } = realDB();
    cleanups.push(() => sql.close());
    sql.exec("INSERT INTO affiliates (id,email,code,status,created_at) VALUES (1,'partner@example.test','partner','active',0),(2,'other@example.test','other','active',0)");
    const secret = 'pagination-test-secret';
    const session = await createSession(1, secret);
    const insert = sql.prepare('INSERT INTO conversions (affiliate_id,stripe_session_id,amount_cents,commission_cents,status,created_at) VALUES (?,?,?,?,?,?)');
    let sequence = 0;
    return {
        add(timestamp, amount = 5000, affiliateId = 1) {
            insert.run(affiliateId, 'cs_pagination_' + sequence++, amount, Math.floor(amount / 5), 'approved', timestamp);
        },
        async get(query = '') {
            return onRequestGet({
                env: { DB, AFFILIATE_SESSION_SECRET: secret },
                request: new Request('https://shop.example/api/affiliate/me' + query, { headers: { Cookie: '__Host-aff_session=' + session } }),
            });
        },
    };
}

describe('affiliate conversion pagination and dates', () => {
    it('pages beyond 100 records with stable ordering and only the signed-in affiliate', async t => {
        const { add, get } = await setup(t);
        for (let i = 1; i <= 125; i++) add(Date.parse('2026-10-10T12:00:00Z'), i * 100);
        add(Date.parse('2026-10-11T12:00:00Z'), 999999, 2);
        const defaultData = await (await get()).json();
        assert.equal(defaultData.conversions.length, 100);
        assert.deepEqual(defaultData.pagination, { page: 1, per_page: 100, total: 125, total_pages: 2 });
        const amounts = [];
        for (let page = 1; page <= 5; page++) {
            const data = await (await get('?page=' + page + '&per_page=25')).json();
            assert.deepEqual(data.pagination, { page, per_page: 25, total: 125, total_pages: 5 });
            amounts.push(...data.conversions.map(row => row.amount_cents));
        }
        assert.deepEqual(amounts, Array.from({ length: 125 }, (_, i) => (125 - i) * 100));
        const last = await (await get('?page=999&per_page=10')).json();
        assert.deepEqual(last.pagination, { page: 13, per_page: 10, total: 125, total_pages: 13 });
        assert.equal(last.conversions.length, 5);
    });

    it('includes both UTC date boundaries and supports one-sided date ranges', async t => {
        const { add, get } = await setup(t);
        add(Date.parse('2026-10-09T23:59:59.999Z'), 1000);
        add(Date.parse('2026-10-10T00:00:00.000Z'), 2000);
        add(Date.parse('2026-10-10T23:59:59.999Z'), 3000);
        add(Date.parse('2026-10-11T00:00:00.000Z'), 4000);
        add(Date.parse('2026-10-10T12:00:00.000Z'), 999999, 2);
        const range = await (await get('?start_date=2026-10-10&end_date=2026-10-10&per_page=1&page=2')).json();
        assert.deepEqual(range.pagination, { page: 2, per_page: 1, total: 2, total_pages: 2 });
        assert.equal(range.conversions[0].amount_cents, 2000);
        const start = await (await get('?start_date=2026-10-10')).json();
        assert.deepEqual(start.conversions.map(row => row.amount_cents), [4000, 3000, 2000]);
        const end = await (await get('?end_date=2026-10-10')).json();
        assert.deepEqual(end.conversions.map(row => row.amount_cents), [3000, 2000, 1000]);
    });

    it('returns an empty first page when no conversions match', async t => {
        const { add, get } = await setup(t);
        add(Date.parse('2026-10-10T12:00:00Z'));
        const data = await (await get('?start_date=2026-10-12&page=99&per_page=25')).json();
        assert.deepEqual(data.conversions, []);
        assert.deepEqual(data.pagination, { page: 1, per_page: 25, total: 0, total_pages: 1 });
    });

    it('rejects invalid page sizes, page numbers, calendar dates, and reversed ranges', async t => {
        const { get } = await setup(t);
        for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=9007199254740992', 'page=',
            'per_page=0', 'per_page=101', 'per_page=1e2', 'per_page=NaN',
            'start_date=2026-02-30', 'end_date=2026-13-01', 'start_date=10/12/2026',
            'start_date=2026-10-12&end_date=2026-10-11', "start_date=2026-10-10' OR 1=1"]) {
            assert.equal((await get('?' + query)).status, 400, query);
        }
    });
});
