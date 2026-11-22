interface D1Result<T> {
    results: T[];
    meta: { changes: number; last_row_id: number };
}

interface D1Statement {
    bind(...values: unknown[]): D1Statement;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

/** The subset of the Cloudflare D1 binding used by cf-affiliate. */
export interface AffiliateDatabase {
    prepare(query: string): D1Statement;
    batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}

export interface AffiliateEnv {
    DB?: AffiliateDatabase;
    ADMIN_TOKEN?: string;
    ADMIN_EMAIL?: string;
    AFFILIATE_SESSION_SECRET?: string;
    AFFILIATE_REF_COOKIE?: string;
    AFFILIATE_REF_LEGACY_COOKIE?: string;
    AFFILIATE_IP_SALT?: string;
    AFFILIATE_DEV_MODE?: string;
    AFFILIATE_TERMS_VERSION?: string;
    /** Whole days before a pending conversion is approved automatically. Unset: manual approval only. */
    AFFILIATE_HOLD_DAYS?: string;
    AFFILIATE_PUBLIC_LIMITER?: {
        limit(options: { key: string }): Promise<{ success: boolean }>;
    };
    STRIPE_SECRET_KEY?: string;
    BREVO_API_KEY?: string;
    EMAIL_URL?: string;
    EMAIL_AUTH_HEADER?: string;
    EMAIL_SENDER_NAME?: string;
    EMAIL_SENDER_ADDRESS?: string;
    SITE_URL?: string;
}

export interface AffiliateExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
}

export interface AffiliateRouteContext {
    request: Request;
    env: AffiliateEnv;
    ctx?: AffiliateExecutionContext;
    params: Record<string, string | string[]>;
}

export type AffiliateRoute = [
    method: string,
    path: string,
    handler: (context: AffiliateRouteContext) => Response | Promise<Response>,
];

export const affiliateRoutes: AffiliateRoute[];
export function handleAffiliateApi(
    request: Request, env: AffiliateEnv, ctx?: AffiliateExecutionContext,
): Promise<Response | null>;

export interface AdminDashboardAppearance {
    brandName?: string;
    logoUrl?: string;
    stylesheets?: readonly string[];
    fontOrigins?: readonly string[];
    title?: string;
}

export function adminDashboard(context?: Partial<AffiliateRouteContext>, appearance?: AdminDashboardAppearance): Response;

export const DEFAULT_REF_COOKIE: 'affiliate_ref';
export function refCookieName(env?: AffiliateEnv | null, request?: Request): string;
export function applyAffiliateRef(
    request: Request, env: AffiliateEnv, respond: () => Response | Promise<Response>, ctx?: AffiliateExecutionContext,
): Promise<Response | null>;

export class PromotionCodeError extends Error {
    constructor(message: string, status?: number, code?: string);
    status: number;
    code: string;
}

export function attachAffiliateAttribution(
    params: URLSearchParams, request: Request, env: AffiliateEnv, options?: { promoCode?: string },
): Promise<void>;

type StripeReference = string | { id: string };

export interface CheckoutLineItem {
    description?: string | null;
    quantity?: number | null;
    price?: { product?: string | { id: string; name?: string } | null; nickname?: string | null } | null;
}

export interface CheckoutSession {
    id: string;
    metadata?: Record<string, string> | null;
    discounts?: readonly { promotion_code?: StripeReference | null }[] | null;
    total_details?: { amount_discount?: number } | null;
    allow_promotion_codes?: boolean | null;
    amount_total?: number | null;
    payment_intent?: StripeReference | null;
    currency?: string | null;
    customer_details?: { email?: string | null; address?: { country?: string | null } | null } | null;
    line_items?: { data?: readonly CheckoutLineItem[] } | null;
}

export interface StripeEvent {
    id?: string;
    created?: number;
    type?: string;
    data?: { object?: unknown };
}

export function recordConversion<T extends CheckoutSession>(
    session: T | null | undefined, event: StripeEvent | null | undefined, env: AffiliateEnv,
    lineItems?: readonly CheckoutLineItem[] | null,
): Promise<(Omit<T, 'metadata'> & { metadata: Record<string, string> }) | null>;

/** Records a verified refund or dispute webhook and returns the number of conversions updated. */
export function recordRefund(event: StripeEvent | null | undefined, env: AffiliateEnv): Promise<number>;

/** Approves pending conversions older than AFFILIATE_HOLD_DAYS. Returns how many were approved; 0 when unset. */
export function releaseHeldConversions(env: AffiliateEnv, now?: number): Promise<number>;
