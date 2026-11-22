import { describe, it, expect } from 'vitest';
import { requireAdmin } from '../../functions/api/admin/_gate.ts';
function request(token) { return new Request('https://shop.example/api/admin/affiliates', { headers: token ? { 'x-admin-token': token } : {} }); }
describe('requireAdmin', () => {
    it('denies missing admin configuration', async () => { expect((await requireAdmin({}, request('anything'))).status).toBe(503); });
    it('accepts the correct header token', async () => { expect(await requireAdmin({ ADMIN_TOKEN: 'secret' }, request('secret'))).toBeNull(); });
    it('rejects a wrong or absent token', async () => {
        for (const token of ['wrong', null]) expect((await requireAdmin({ ADMIN_TOKEN: 'secret' }, request(token))).status).toBe(401);
    });
});
