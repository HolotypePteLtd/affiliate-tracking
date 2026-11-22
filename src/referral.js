// Signup referrals.
//
// Call when one of your users signs up, with the signup request (or its
// headers) and your own user id. The referral cookie is read and the user is
// tied to that affiliate for good, so a purchase weeks later is still credited
// even after the cookie has expired or the user switched browsers.
//
//   await recordSignupReferral(request, env, user.id);
//
// Then pass the same id to checkout: attachAffiliateAttribution(params,
// request, env, { userId: user.id }). The stored referral comes first, the
// cookie only when there is none, and an entered affiliate promo code still
// wins (and is stored) at the first payment.

import { readAffiliateRef } from './ref.js';

const MAX_USER_ID = 255;

export function validUserId(userId) {
    return typeof userId === 'string' && userId.length > 0 && userId.length <= MAX_USER_ID;
}

function asRequest(source, env) {
    if (source instanceof Request) return source;
    const headers = source instanceof Headers ? source : new Headers(source?.headers || source || {});
    return new Request(env?.SITE_URL || 'https://invalid.local', { headers });
}

export async function recordSignupReferral(requestOrHeaders, env, userId) {
    if (!validUserId(userId) || !env.DB) return null;
    const request = asRequest(requestOrHeaders, env);
    const code = readAffiliateRef(request, env);
    if (!code) return null;
    const affiliate = await env.DB.prepare(
        "SELECT id, code FROM affiliates WHERE code=?1 AND status='active'"
    ).bind(code).first();
    if (!affiliate) return null;
    await env.DB.prepare(`INSERT INTO referrals (id, user_id, affiliate_id, source, created_at)
        VALUES (?1, ?2, ?3, 'signup', ?4) ON CONFLICT(user_id) DO NOTHING`)
        .bind(crypto.randomUUID(), userId, affiliate.id, Date.now()).run();
    return referralFor(env, userId);
}

// The user's referral, if its affiliate is still active.
export async function referralFor(env, userId) {
    if (!validUserId(userId) || !env.DB) return null;
    return env.DB.prepare(`SELECT r.id, r.user_id, r.affiliate_id, r.source, r.converted_at,
               a.code, a.promo_code_id
        FROM referrals r JOIN affiliates a ON a.id=r.affiliate_id
        WHERE r.user_id=?1 AND a.status='active'`).bind(userId).first();
}

// After a paid conversion for this user: store who got the sale. Before the
// first conversion a promo code (or, with no referral yet, the checkout cookie)
// sets the affiliate; after it, the row is fixed.
export async function settleReferral(env, { userId, affiliateId, source, stripeCustomerId, at }) {
    if (!validUserId(userId)) return;
    await env.DB.prepare(`INSERT INTO referrals (id, user_id, affiliate_id, source, stripe_customer_id, created_at, converted_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(user_id) DO UPDATE SET
          affiliate_id=CASE WHEN referrals.converted_at IS NULL AND excluded.source='promo_code'
                            THEN excluded.affiliate_id ELSE referrals.affiliate_id END,
          source=CASE WHEN referrals.converted_at IS NULL AND excluded.source='promo_code'
                      THEN 'promo_code' ELSE referrals.source END,
          stripe_customer_id=COALESCE(referrals.stripe_customer_id, excluded.stripe_customer_id),
          converted_at=COALESCE(referrals.converted_at, excluded.converted_at)`)
        .bind(crypto.randomUUID(), userId, affiliateId, source === 'promo_code' ? 'promo_code' : 'checkout',
            stripeCustomerId || null, at).run();
}
