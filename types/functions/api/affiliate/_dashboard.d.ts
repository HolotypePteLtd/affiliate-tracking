import type { AffiliateEnv, AffiliatesRow, ConversionsRow } from '../../../src/types.ts';
export type SignedInAffiliate = Pick<AffiliatesRow, 'id' | 'code' | 'name' | 'email' | 'commission_pct' | 'status' | 'stripe_account_id'>;
export declare function signedInAffiliate(request: Request, env: AffiliateEnv): Promise<Response | SignedInAffiliate>;
export declare function positiveInteger(params: URLSearchParams, name: string, fallback: number, max?: number): number | null;
export declare function conversionFilter(params: URLSearchParams, affiliateId: number): Response | {
    where: string;
    bindings: (string | number)[];
};
export declare function pagination(requestedPage: number, perPage: number, total: number): {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
};
export declare function reference(kind: string, id: number): string;
export declare const CONVERSION_COLUMNS = "id, status, amount_cents, commission_cents, currency, customer_country, commission_pct, items_json, created_at, approved_at, paid_at, payout_id";
export declare function publicConversion(row: ConversionsRow): {
    reference: string;
    status: string;
    amount_cents: number;
    commission_cents: number;
    currency: string | null;
    currency_decimals: number | null;
    country: string | null;
    commission_pct: number | null;
    items: {
        product_id: {} | null;
        name: {} | null;
        variant: {} | null;
        quantity: unknown;
    }[];
    created_at: number;
    approved_at: number | null;
    paid_at: number | null;
    payout_reference: string | null;
};
