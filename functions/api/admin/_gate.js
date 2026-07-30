// Shared admin gate: returns null on authorized, or a 401 Response on failure.
// Imports constantTimeCompare the same way verify-products.js does.

import { constantTimeCompare } from '../_crypto-utils.js';

export function requireAdmin(env, request) {
    if (!env.ADMIN_TOKEN) return null; // open when unprovisioned
    const provided = request.headers.get('x-admin-token') || '';
    if (!constantTimeCompare(provided, env.ADMIN_TOKEN)) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
        });
    }
    return null;
}
