//   POST /api/admin/bonus { affiliate_id, amount_cents, currency, note }
//     A one-off bonus line. It is approved straight away and paid with the
//     affiliate's next payout.

import { requireAdmin } from './_gate.js';
import { readJsonObject } from '../_public.js';
import { currencyCode } from '../../../src/money.js';

export async function onRequestPost({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const { affiliate_id: affiliateId, amount_cents: amount, currency, note } = await readJsonObject(request);
    if (!Number.isSafeInteger(affiliateId) || affiliateId <= 0 || !Number.isSafeInteger(amount) || amount <= 0 ||
        !currencyCode(currency) || typeof note !== 'string' || !note.trim() || note.length > 200) {
        return Response.json({ ok: false, error: 'affiliate_id, a positive amount_cents, a currency and a note of up to 200 characters are required' }, { status: 400 });
    }
    const now = Date.now();
    const id = 'bonus_' + crypto.randomUUID();
    const result = await env.DB.prepare(`INSERT INTO conversions
        (affiliate_id, stripe_session_id, amount_cents, commission_cents, status, created_at, approved_at, currency, bonus_note)
        SELECT id, ?2, 0, ?3, 'approved', ?4, ?4, ?5, ?6 FROM affiliates WHERE id=?1 AND status='active'`)
        .bind(affiliateId, id, amount, now, currencyCode(currency), note.trim()).run();
    if (!result.meta?.changes) return Response.json({ ok: false, error: 'Active affiliate not found' }, { status: 404 });
    return Response.json({ ok: true, reference: id }, { status: 201 });
}
