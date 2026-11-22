//   POST /api/admin/affiliate-review { id, review_required }
//     review_required=true keeps every conversion of this affiliate in the
//     manual approval queue even when AFFILIATE_HOLD_DAYS is set.

import { requireAdmin } from './_gate.js';
import { readJsonObject } from '../_public.js';

export async function onRequestPost({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    const db = env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const { id, review_required: reviewRequired } = await readJsonObject(request);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof reviewRequired !== 'boolean') {
        return Response.json({ ok: false, error: 'An affiliate id and a true or false review_required are required' }, { status: 400 });
    }
    const result = await db.prepare('UPDATE affiliates SET review_required=?1 WHERE id=?2')
        .bind(reviewRequired ? 1 : 0, id).run();
    if (!result.meta?.changes) {
        return Response.json({ ok: false, error: 'Affiliate not found' }, { status: 404 });
    }
    return Response.json({ ok: true, affiliate_id: id, review_required: reviewRequired });
}
