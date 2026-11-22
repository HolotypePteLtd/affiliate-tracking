import type { AffiliateEnv } from './types.ts';
export declare function attachAffiliateAttribution(params: URLSearchParams, request: Request, env: AffiliateEnv, { promoCode }?: {
    promoCode?: string;
}): Promise<void>;
