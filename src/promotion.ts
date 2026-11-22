import type { AffiliateEnv, AffiliatesRow, StripeObject } from './types.ts';
// Stripe, rather than a submitted string or promotion metadata, confirms which
// promotion was applied. Affiliate ownership comes from this host's D1 records.

export class PromotionCodeError extends Error {
    status: number;
    code: string;

    constructor(message: string, status = 400, code = 'invalid_promo_code') {
        super(message);
        this.name = 'PromotionCodeError';
        this.status = status;
        this.code = code;
    }
}

export async function findPromotionCode(code: string, env: AffiliateEnv) {
    if (!env.STRIPE_SECRET_KEY) {
        throw new PromotionCodeError('Promotion codes are temporarily unavailable.', 503, 'promo_code_unavailable');
    }
    const query = new URLSearchParams({ code, active: 'true', limit: '100' });
    let response;
    try {
        response = await fetch(`https://api.stripe.com/v1/promotion_codes?${query}`, {
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
            signal: AbortSignal.timeout(10000),
        });
    } catch {
        throw new PromotionCodeError('Promotion codes are temporarily unavailable.', 503, 'promo_code_unavailable');
    }
    if (!response.ok) {
        throw new PromotionCodeError('Promotion codes are temporarily unavailable.', 503, 'promo_code_unavailable');
    }
    const result: StripeObject = await response.json();
    const matches = (result.data || []).filter((promo: StripeObject) =>
        typeof promo.id === 'string' && promo.id.startsWith('promo_') &&
        promo.active === true && typeof promo.code === 'string' &&
        promo.code.toLowerCase() === code.toLowerCase() &&
        (!promo.expires_at || promo.expires_at > Date.now() / 1000)
    );
    const publicCodes = matches.filter((promo: StripeObject) => !promo.customer && !promo.customer_account);
    const candidates = publicCodes.length ? publicCodes : matches;
    if (result.has_more || candidates.length !== 1) {
        throw new PromotionCodeError('This promo code is invalid or unavailable. Check it or remove it to continue.');
    }
    return candidates[0];
}

export async function affiliateForPromotion(promotionId: string, env: AffiliateEnv) {
    if (!env.DB) return null;
    const { results } = await env.DB.prepare(
        "SELECT id, code, promo_code_id FROM affiliates WHERE promo_code_id=?1 AND status='active' LIMIT 2"
    ).bind(promotionId).all<Pick<AffiliatesRow, 'id' | 'code' | 'promo_code_id'>>();
    if (results.length > 1) throw new Error('Affiliate promotion ownership is ambiguous');
    return results[0] || null;
}

export async function resolvePaidAttribution(session: StripeObject, env: AffiliateEnv): Promise<StripeObject> {
    let paidSession = session;
    // Older cookie-only integrations need no new Stripe call. New sessions
    // must verify their final discounts if the signed event omits that field.
    if (session.discounts === undefined && (
        session.metadata?.affiliate_attribution_version === 'promo-first-v1' ||
        session.metadata?.affiliate_source === 'promo_code' || session.allow_promotion_codes
    )) {
        if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured for promotion verification');
        const response = await fetch(
            `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session.id)}?expand[]=discounts.promotion_code`,
            { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(10000) }
        );
        if (!response.ok) throw new Error('Failed to verify applied checkout promotions');
        const verified: StripeObject = await response.json();
        if (verified.id !== session.id || !('discounts' in verified)) {
            throw new Error('Checkout promotion verification was incomplete');
        }
        paidSession = { ...session, discounts: verified.discounts, total_details: verified.total_details ?? session.total_details };
    }

    const metadata = { ...session.metadata };
    const owners = new Map();
    const discountAmount = paidSession.total_details?.amount_discount;
    if (!Number.isFinite(discountAmount) || discountAmount > 0) {
        for (const discount of paidSession.discounts || []) {
            const promo = discount.promotion_code;
            const id = typeof promo === 'string' ? promo : promo?.id;
            if (!id) continue;
            const affiliate = await affiliateForPromotion(id, env);
            if (affiliate) owners.set(String(affiliate.id), affiliate);
        }
    }
    if (owners.size > 1) throw new Error('Applied affiliate promotions conflict');
    const affiliate = [...owners.values()][0];
    if (affiliate) {
        metadata.affiliate_id = String(affiliate.id);
        metadata.affiliate_code = affiliate.code;
        metadata.affiliate_source = 'promo_code';
    } else {
        // A removed/rejected code cannot retain the affiliate selected when
        // checkout was created. Fall back only to the captured valid cookie.
        const cookieId = metadata.affiliate_cookie_id ??
            (metadata.affiliate_source !== 'promo_code' ? metadata.affiliate_id : null);
        const cookieCode = metadata.affiliate_cookie_code ?? metadata.affiliate_code;
        delete metadata.affiliate_id;
        delete metadata.affiliate_code;
        delete metadata.affiliate_source;
        if (cookieId) {
            metadata.affiliate_id = String(cookieId);
            if (cookieCode) metadata.affiliate_code = cookieCode;
            metadata.affiliate_source = 'cookie';
        }
    }
    return { ...paidSession, metadata };
}
