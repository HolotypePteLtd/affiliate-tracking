import { it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { onRequestPost as apply } from '../../functions/api/affiliate/apply.ts';
import { database } from './_db.js';
const handles = [];
const realDB = () => { const db = database(); handles.push(db.sql); return db; };
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); });
const allowLimiter = { async limit() { return { success: true }; } };
const req = (path, { body }) => new Request('https://shop.example' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const VERSION = '2026-10-12';
const request = body => req('/api/affiliate/apply', { method: 'POST', body });
const accepted = email => ({ email, accepted_terms: true, terms_version: VERSION });

it('rejects missing, false, truthy-string and stale acceptance before writes or email', async () => {
    const { sql, DB } = realDB();
    const env = { DB, AFFILIATE_TERMS_VERSION: VERSION, AFFILIATE_PUBLIC_LIMITER: allowLimiter };
    for (const extra of [{}, { accepted_terms: false, terms_version: VERSION },
        { accepted_terms: 'true', terms_version: VERSION }, { accepted_terms: true },
        { accepted_terms: true, terms_version: 'old-version' }]) {
        const response = await apply({ request: request({ email: 'partner@example.com', ...extra }), env });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).terms_version, VERSION);
    }
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM affiliates').get().n, 0);
});

it('records the accepted policy with server time and preserves original acceptance on duplicate applications', async () => {
    const { sql, DB } = realDB();
    const env = { DB, AFFILIATE_TERMS_VERSION: VERSION, AFFILIATE_PUBLIC_LIMITER: allowLimiter };
    const before = Date.now();
    const first = await apply({ request: request({ ...accepted('Partner@Example.com'), terms_accepted_at: 1 }), env });
    assert.equal(first.status, 200);
    const saved = sql.prepare('SELECT email,status,terms_version,terms_accepted_at,applied_at FROM affiliates').get();
    assert.equal(saved.email, 'partner@example.com');
    assert.equal(saved.status, 'pending');
    assert.equal(saved.terms_version, VERSION);
    assert.equal(saved.terms_accepted_at, saved.applied_at);
    assert.ok(saved.terms_accepted_at >= before && saved.terms_accepted_at <= Date.now());
    const updatedVersion = '2026-11-01';
    const duplicate = await apply({ request: request({ ...accepted('partner@example.com'), terms_version: updatedVersion }),
        env: { ...env, AFFILIATE_TERMS_VERSION: updatedVersion } });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), await first.json());
    assert.deepEqual(sql.prepare('SELECT email,status,terms_version,terms_accepted_at,applied_at FROM affiliates').get(), saved);
});

it('does not manufacture acceptance for existing/admin-created accounts or hosts without a terms policy', async () => {
    const { sql, DB } = realDB();
    sql.exec("INSERT INTO affiliates (email,code,status,created_at) VALUES ('existing@example.com','existing','active',0)");
    const env = { DB, AFFILIATE_PUBLIC_LIMITER: allowLimiter };
    assert.equal((await apply({ request: request({ email: 'new@example.com' }), env })).status, 200);
    const existing = await apply({ request: request(accepted('existing@example.com')), env: { ...env, AFFILIATE_TERMS_VERSION: VERSION } });
    assert.equal(existing.status, 200);
    for (const row of sql.prepare('SELECT terms_version,terms_accepted_at FROM affiliates').all()) {
        assert.equal(row.terms_version, null);
        assert.equal(row.terms_accepted_at, null);
    }
});
