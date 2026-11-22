export declare function signedInAffiliate(request: any, env: any): Promise<any>;
export declare function positiveInteger(params: any, name: any, fallback: any, max?: number): any;
export declare function conversionFilter(params: any, affiliateId: any): Response | {
    where: string;
    bindings: any[];
};
export declare function pagination(requestedPage: any, perPage: any, total: any): {
    page: number;
    per_page: any;
    total: any;
    total_pages: number;
};
export declare function reference(kind: any, id: any): string;
export declare const CONVERSION_COLUMNS = "id, status, amount_cents, commission_cents, currency, customer_country, commission_pct, items_json, created_at, approved_at, paid_at, payout_id";
export declare function publicConversion(row: any): {
    reference: string;
    status: any;
    amount_cents: any;
    commission_cents: any;
    currency: string | null;
    currency_decimals: number | null | undefined;
    country: any;
    commission_pct: any;
    items: any;
    created_at: any;
    approved_at: any;
    paid_at: any;
    payout_reference: string | null;
};
