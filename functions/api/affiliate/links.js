//   GET  /api/affiliate/links                    the signed-in affiliate's links, with clicks and sales
//   POST /api/affiliate/links { destination, campaign?, slug? }   create a link
//   POST /api/affiliate/link-archive { id }      archive a link (it stops redirecting)

import { signedInAffiliate } from './_dashboard.js';
import { readJsonObject } from '../_public.js';
import { isSameOrigin } from '../_admin-auth.js';
import { listLinks, createLink, archiveLink } from '../../../src/links.js';

export async function onRequestGet({ request, env }) {
    const aff = await signedInAffiliate(request, env);
    if (aff instanceof Response) return aff;
    return Response.json({ links: await listLinks(env, request, aff.id) });
}

export async function onRequestPost({ request, env }) {
    if (!isSameOrigin(request)) return Response.json({ error: 'Cross-origin request denied' }, { status: 403 });
    const aff = await signedInAffiliate(request, env);
    if (aff instanceof Response) return aff;
    const result = await createLink(env, request, aff, await readJsonObject(request));
    if (result.error) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ link: result.link }, { status: 201 });
}

export async function onArchivePost({ request, env }) {
    if (!isSameOrigin(request)) return Response.json({ error: 'Cross-origin request denied' }, { status: 403 });
    const aff = await signedInAffiliate(request, env);
    if (aff instanceof Response) return aff;
    const { id } = await readJsonObject(request);
    return await archiveLink(env, aff.id, id)
        ? Response.json({ ok: true })
        : Response.json({ error: 'Link not found' }, { status: 404 });
}
