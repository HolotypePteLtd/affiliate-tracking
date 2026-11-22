import type { AffiliateEnv, AffiliatesRow, StripeObject } from './types.ts';
export declare class PromotionCodeError extends Error {
    status: number;
    code: string;
    constructor(message: string, status?: number, code?: string);
}
export declare function findPromotionCode(code: string, env: AffiliateEnv): Promise<any>;
export declare function affiliateForPromotion(promotionId: string, env: AffiliateEnv): Promise<Pick<AffiliatesRow, "code" | "id" | "promo_code_id"> | null>;
export declare function resolvePaidAttribution(session: StripeObject, env: AffiliateEnv): Promise<StripeObject>;
