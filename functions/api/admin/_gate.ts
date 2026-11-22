// Shared admin gate: null on authorization, 401/403/503 on failure.
// Imports constantTimeCompare the same way verify-products.js does.

import { constantTimeCompare } from '../_crypto-utils.ts';
import { readAdminSession, isSameOrigin } from '../_admin-auth.ts';

export async function requireAdmin(env, request) {
    if (!env.ADMIN_TOKEN) {
        return Response.json({ ok: false, error: 'Admin access is not configured' }, { status: 503 });
    }
    const provided = request.headers.get('x-admin-token');
    if (provided && constantTimeCompare(provided, env.ADMIN_TOKEN)) return null;
    // Browser sessions never expose the admin token to JS. Cookie-authenticated
    // mutations must come from our own origin; CLI header auth remains supported.
    if (!provided && await readAdminSession(request, env.ADMIN_TOKEN)) {
        if (['GET', 'HEAD'].includes(request.method) || isSameOrigin(request)) return null;
        return Response.json({ ok: false, error: 'Cross-origin admin request denied' }, { status: 403 });
    }
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}
