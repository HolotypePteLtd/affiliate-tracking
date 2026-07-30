//   POST /api/affiliate/logout
//     Clears the session cookie.

import { clearSessionCookieHeader } from '../_affiliate-auth.js';

export async function onRequestPost(context) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', clearSessionCookieHeader(context.request.url));
    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
}
