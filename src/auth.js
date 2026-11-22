// Pluggable sign-in.
//
// Pass your own auth to handleAffiliateApi instead of (or as well as) the
// built-in magic links and ADMIN_TOKEN:
//
//   handleAffiliateApi(request, env, ctx, { auth: {
//       // Who is signed in, or null. Return the email only once verified.
//       affiliate: async (request, env) => ({ userId, email }) | null,
//       // Is the signed-in user an admin?
//       admin: async (request, env) => true | false,
//   } });
//
// An affiliate is matched by user id, or on their first sign-in by email
// (case-insensitive), which then links the user id to them. The built-in
// methods keep working alongside: magic-link sessions for affiliates, and the
// x-admin-token header for scripts.

const bound = new WeakMap();

export function validateAuth(auth) {
    if (auth === undefined || auth === null) return null;
    if (typeof auth !== 'object') throw new TypeError('auth must be an object');
    for (const key of ['affiliate', 'admin']) {
        if (auth[key] !== undefined && typeof auth[key] !== 'function') throw new TypeError(`auth.${key} must be a function`);
    }
    return auth;
}

export function bindAuth(request, auth) {
    if (auth) bound.set(request, auth);
}

export function authFor(request) {
    return bound.get(request) || null;
}

// The active affiliate for an identity from auth.affiliate, linking the
// user id on the first email match.
export async function affiliateForIdentity(env, identity) {
    const userId = typeof identity?.userId === 'string' && identity.userId ? identity.userId : null;
    const email = typeof identity?.email === 'string' ? identity.email.trim().toLowerCase() : '';
    if (!userId) return null;
    const columns = 'id, code, name, email, commission_pct, status, stripe_account_id, user_id';
    const linked = await env.DB.prepare(`SELECT ${columns} FROM affiliates WHERE user_id=?1`).bind(userId).first();
    if (linked) return linked.status === 'active' ? linked : null;
    if (!email) return null;
    const byEmail = await env.DB.prepare(`SELECT ${columns} FROM affiliates
        WHERE lower(email)=?1 AND user_id IS NULL AND status='active'`).bind(email).first();
    if (!byEmail) return null;
    const result = await env.DB.prepare('UPDATE affiliates SET user_id=?1 WHERE id=?2 AND user_id IS NULL')
        .bind(userId, byEmail.id).run();
    return result.meta?.changes ? { ...byEmail, user_id: userId } : null;
}
