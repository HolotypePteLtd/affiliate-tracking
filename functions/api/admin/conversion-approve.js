//   POST /api/admin/conversion-approve { id, approved }
//     Sets a conversion to approved (or back to pending for reversal).
//     approved=true (default) -> status=approved; approved=false -> pending.

import { requireAdmin } from './_gate.js';

export async function onRequestPost(context) {
    const gate = requireAdmin(context.env, context.request);
    if (gate) return gate;

    const db = context.env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });

    const { id, approved } = await context.request.json().catch(() => ({}));
    if (!id) {
        return Response.json({ ok: false, error: 'Conversion id is required' }, { status: 400 });
    }

    // Only allow approving conversions that are currently pending (or
    // re-opening approved ones to pending).
    const newStatus = approved !== false ? 'approved' : 'pending';
    const result = await db.prepare(
        "UPDATE conversions SET status=?1 WHERE id=?2 AND status IN ('pending','approved')"
    ).bind(newStatus, id).run();

    if (!result.meta?.changes) {
        return Response.json({ ok: false, error: 'Conversion not found or not in pending/approved status' }, { status: 404 });
    }

    return Response.json({ ok: true, conversion_id: id, status: newStatus });
}
