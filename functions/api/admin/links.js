//   GET  /api/admin/links?affiliate_id=1                         an affiliate's links
//   POST /api/admin/links { affiliate_id, destination, campaign?, slug? }   create one for them
//   POST /api/admin/link-archive { affiliate_id, id }            archive one

import { requireAdmin } from './_gate.js';
import { readJsonObject } from '../_public.js';
import { listLinks, createLink, archiveLink } from '../../../src/links.js';

async function affiliateById(env, id) {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return env.DB.prepare('SELECT id, code FROM affiliates WHERE id=?1').bind(id).first();
}

export async function onRequestGet({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const aff = await affiliateById(env, Number(new URL(request.url).searchParams.get('affiliate_id')));
    if (!aff) return Response.json({ ok: false, error: 'Affiliate not found' }, { status: 404 });
    return Response.json({ ok: true, links: await listLinks(env, request, aff.id) });
}

export async function onRequestPost({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const body = await readJsonObject(request);
    const aff = await affiliateById(env, body.affiliate_id);
    if (!aff) return Response.json({ ok: false, error: 'Affiliate not found' }, { status: 404 });
    const result = await createLink(env, request, aff, body);
    if (result.error) return Response.json({ ok: false, error: result.error }, { status: result.status });
    return Response.json({ ok: true, link: result.link }, { status: 201 });
}

export async function onArchivePost({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const { affiliate_id: affiliateId, id } = await readJsonObject(request);
    return await archiveLink(env, affiliateId, id)
        ? Response.json({ ok: true })
        : Response.json({ ok: false, error: 'Link not found' }, { status: 404 });
}
