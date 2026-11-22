import { requireAdmin } from './_gate.ts';
import { readJsonObject } from '../_public.ts';
import type { AffiliateRouteContext } from '../../../src/types.ts';

export async function onRequestPost({ request, env }: AffiliateRouteContext) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const { id } = await readJsonObject(request);
    if (!Number.isSafeInteger(id) || id <= 0) {
        return Response.json({ ok: false, error: 'Affiliate id is required' }, { status: 400 });
    }
    const updated = await env.DB.prepare('UPDATE affiliates SET session_version=session_version+1 WHERE id=?1')
        .bind(id).run();
    if (!updated.meta.changes) return Response.json({ ok: false, error: 'Affiliate not found' }, { status: 404 });
    return Response.json({ ok: true, affiliate_id: id });
}
