// Explicit local opt-in plus a loopback host. Never enabled by [vars] in a
// deployable config. Demo sign-in is restricted to the seeded demo identity.
import { createSession, sessionCookieHeader } from '../functions/api/_affiliate-auth.ts';
import { createAdminSession, adminSessionCookieHeader, isSameOrigin } from '../functions/api/_admin-auth.ts';
import type { AffiliateEnv, AffiliateRouteContext, AffiliatesRow } from './types.ts';

export const DEMO_EMAIL = 'demo@example.test';
export const DEMO_CODE = 'local-demo';

export function isLocalAffiliateDev(request: Request, env: AffiliateEnv) {
    return env.AFFILIATE_DEV_MODE === 'true'
        && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
}

export function devInfo({ request, env }: AffiliateRouteContext) {
    if (!isLocalAffiliateDev(request, env)) return new Response('Not found', { status: 404 });
    return Response.json({ enabled: true, email: DEMO_EMAIL }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function devLogin({ request, env }: AffiliateRouteContext) {
    if (!isLocalAffiliateDev(request, env)) return new Response('Not found', { status: 404 });
    if (!isSameOrigin(request)) return Response.json({ error: 'Same-origin request required' }, { status: 403 });
    if (!env.DB || !env.AFFILIATE_SESSION_SECRET) {
        return Response.json({ error: 'Run the local affiliate setup first.' }, { status: 503 });
    }
    const affiliate = await env.DB.prepare(
        "SELECT id, session_version FROM affiliates WHERE email=?1 AND code=?2 AND source='local-demo' AND status='active'"
    ).bind(DEMO_EMAIL, DEMO_CODE).first<Pick<AffiliatesRow, 'id' | 'session_version'>>();
    if (!affiliate) return Response.json({ error: 'Run the local affiliate setup first.' }, { status: 503 });
    const session = await createSession(affiliate.id, env.AFFILIATE_SESSION_SECRET, affiliate.session_version);
    return Response.json({ ok: true }, { headers: {
        'Set-Cookie': sessionCookieHeader(session, request.url), 'Cache-Control': 'no-store',
    } });
}

export async function devAdminLogin({ request, env }: AffiliateRouteContext) {
    if (!isLocalAffiliateDev(request, env)) return new Response('Not found', { status: 404 });
    if (!isSameOrigin(request)) return Response.json({ error: 'Same-origin request required' }, { status: 403 });
    if (!env.ADMIN_TOKEN) return Response.json({ error: 'Run the local affiliate setup first.' }, { status: 503 });
    const session = await createAdminSession(env.ADMIN_TOKEN);
    return Response.json({ ok: true }, { headers: {
        'Set-Cookie': adminSessionCookieHeader(session, request.url), 'Cache-Control': 'no-store',
    } });
}
