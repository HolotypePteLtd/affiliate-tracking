// Checkout attribution.
//
// Call once on the URLSearchParams you are about to POST to
// https://api.stripe.com/v1/checkout/sessions, in every branch that creates
// a session. Reads the attribution cookie, resolves the affiliate, and appends
// client_reference_id + metadata + the buyer-discount promotion code.
//
//   await attachAffiliateAttribution(params, request, env);
//
// No-op (resolves without touching `params`) when there is no cookie, no DB
// binding, or no active affiliate — checkout must never break because the
// affiliate layer is unconfigured.

import { parseCookies, refCookieName } from './ref.js';

export async function attachAffiliateAttribution(params, request, env) {
    if (!(params instanceof URLSearchParams) || !env.DB) return;

    const refCode = parseCookies(request.headers.get('Cookie'))[refCookieName(env)];
    if (!refCode) return;

    let aff;
    try {
        aff = await env.DB.prepare(
            "SELECT id, code, promo_code_id FROM affiliates WHERE code=?1 AND status='active'"
        ).bind(refCode).first();
    } catch (err) {
        console.error('Affiliate lookup failed during checkout:', err.message);
        return;
    }
    if (!aff) return;

    // The site's own referral field also uses client_reference_id; only send
    // ours when the caller hasn't already set it.
    if (!params.get('client_reference_id')) {
        params.append('client_reference_id', aff.code);
    }
    params.append('metadata[affiliate_id]', String(aff.id));
    params.append('metadata[affiliate_code]', aff.code);
    // Buyer discount. Pre-applied via the promotion code minted at approval
    // time; absent until an admin approves the affiliate.
    if (aff.promo_code_id) {
        params.append('discounts[0][promotion_code]', aff.promo_code_id);
    }
}
