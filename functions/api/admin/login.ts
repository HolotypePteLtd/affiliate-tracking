import { constantTimeCompare } from '../_crypto-utils.ts';
import { readPublicBody, limitPublicRequest } from '../_public.ts';
import { createAdminSession, adminSessionCookieHeader, isSameOrigin } from '../_admin-auth.ts';
import type { AffiliateRouteContext } from '../../../src/types.ts';

export async function onRequestPost({ request, env }: AffiliateRouteContext) {
    if (!isSameOrigin(request)) {
        return Response.json({ ok: false, error: 'Cross-origin admin request denied' }, { status: 403 });
    }
    if (!env.ADMIN_TOKEN) {
        return Response.json({ ok: false, error: 'Admin access is not configured' }, { status: 503 });
    }
    const limited = await limitPublicRequest(request, env);
    if (limited) return limited;
    const body = await readPublicBody(request);
    if (typeof body?.token !== 'string' || !constantTimeCompare(body.token, env.ADMIN_TOKEN)) {
        return Response.json({ ok: false, error: 'Invalid admin token' }, { status: 401 });
    }
    const session = await createAdminSession(env.ADMIN_TOKEN);
    return Response.json({ ok: true }, { headers: {
        'Set-Cookie': adminSessionCookieHeader(session, request.url),
        'Cache-Control': 'no-store',
    } });
}
