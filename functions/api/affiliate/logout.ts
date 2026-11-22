//   POST /api/affiliate/logout
//     Clears the session cookie.

import { clearSessionCookieHeader } from '../_affiliate-auth.ts';
import { isSameOrigin } from '../_admin-auth.ts';
import type { AffiliateRouteContext } from '../../../src/types.ts';

export async function onRequestPost(context: AffiliateRouteContext) {
    if (!isSameOrigin(context.request)) {
        return Response.json({ success: false, error: 'Cross-origin request denied' }, { status: 403 });
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', clearSessionCookieHeader(context.request.url));
    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
}
