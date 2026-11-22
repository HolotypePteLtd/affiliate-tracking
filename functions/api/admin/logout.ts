import { adminSessionCookieHeader, isSameOrigin } from '../_admin-auth.ts';

export async function onRequestPost({ request }) {
    if (!isSameOrigin(request)) {
        return Response.json({ ok: false, error: 'Cross-origin admin request denied' }, { status: 403 });
    }
    return Response.json({ ok: true }, { headers: {
        'Set-Cookie': adminSessionCookieHeader('', request.url, 0),
        'Cache-Control': 'no-store',
    } });
}
