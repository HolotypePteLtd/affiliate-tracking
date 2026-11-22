// Checkout attribution.
//
// Call once on the URLSearchParams you are about to POST to
// https://api.stripe.com/v1/checkout/sessions, in every branch that creates
// a session. An optional customer-supplied promoCode takes priority over the
// cookie. Stripe validates redemption; recordConversion checks the paid order.
//
//   await attachAffiliateAttribution(params, request, env);
//
// With no entered code, no-op when there is no cookie, no DB
// binding, conflicting referral cookies, or no active affiliate — checkout
// remains available when cookie tracking is unconfigured or ambiguous. An
// unusable entered code throws PromotionCodeError for the host to display.

import { readAffiliateRef } from './ref.js';
import { findPromotionCode, affiliateForPromotion, PromotionCodeError } from './promotion.js';
import { requestIpHash } from './ip.js';

export async function attachAffiliateAttribution(params, request, env, { promoCode } = {}) {
    if (!(params instanceof URLSearchParams)) return;
    if (promoCode !== undefined && (typeof promoCode !== 'string' || promoCode.length > 256)) {
        throw new PromotionCodeError('Invalid promo code.');
    }
    const enteredCode = promoCode?.trim();
    const promotion = enteredCode ? await findPromotionCode(enteredCode, env) : null;

    const refCode = readAffiliateRef(request, env);
    let cookieAffiliate = null;
    if (refCode && env.DB) {
        try {
            cookieAffiliate = await env.DB.prepare(
                "SELECT id, code, promo_code_id FROM affiliates WHERE code=?1 AND status='active'"
            ).bind(refCode).first();
        } catch (err) {
            console.error('Affiliate lookup failed during checkout:', err.message);
            if (!promotion) return;
            throw new PromotionCodeError('Promotion codes are temporarily unavailable.', 503, 'promo_code_unavailable');
        }
    }
    let promoAffiliate = null;
    if (promotion) {
        try {
            promoAffiliate = await affiliateForPromotion(promotion.id, env);
        } catch {
            throw new PromotionCodeError('Promotion codes are temporarily unavailable.', 503, 'promo_code_unavailable');
        }
    }
    const aff = promoAffiliate || cookieAffiliate;
    if (!aff && !promotion) return;
    params.set('metadata[affiliate_attribution_version]', 'promo-first-v1');
    if (cookieAffiliate) {
        params.set('metadata[affiliate_cookie_id]', String(cookieAffiliate.id));
        params.set('metadata[affiliate_cookie_code]', cookieAffiliate.code);
    }

    // The site's own referral field also uses client_reference_id; only send
    // ours when the caller hasn't already set it.
    if (aff) {
        if (!params.get('client_reference_id')) params.set('client_reference_id', aff.code);
        params.set('metadata[affiliate_id]', String(aff.id));
        params.set('metadata[affiliate_code]', aff.code);
        params.set('metadata[affiliate_source]', promoAffiliate ? 'promo_code' : 'cookie');
        // For the self-referral check: compared with the affiliate's own
        // sign-in IP hashes when the sale is recorded. Never a raw IP.
        const buyerIpHash = await requestIpHash(request, env);
        if (buyerIpHash) params.set('metadata[affiliate_buyer_ip_hash]', buyerIpHash);
    }
    // Buyer discount. Pre-applied via the promotion code minted at approval
    // time; absent until an admin approves the affiliate.
    const promotionId = promotion?.id || cookieAffiliate?.promo_code_id;
    if (promotionId) {
        // Stripe rejects Checkout Sessions that combine `discounts` with
        // `allow_promotion_codes`, or a single discount item with both coupon
        // and promotion_code.
        params.delete('allow_promotion_codes');
        params.delete('discounts[0][coupon]');
        params.set('discounts[0][promotion_code]', promotionId);
    }
}
