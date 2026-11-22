export declare class PromotionCodeError extends Error {
    status: number;
    code: string;
    constructor(message: string, status?: number, code?: string);
}
export declare function findPromotionCode(code: any, env: any): Promise<any>;
export declare function affiliateForPromotion(promotionId: any, env: any): Promise<any>;
export declare function resolvePaidAttribution(session: any, env: any): Promise<any>;
