// Public types of cf-affiliate. Row types come from the schema (db-types.ts).
export type * from './db-types.ts';

export interface AffiliateEnv {
    DB?: D1Database;
    ADMIN_TOKEN?: string;
    ADMIN_EMAIL?: string;
    AFFILIATE_SESSION_SECRET?: string;
    AFFILIATE_REF_COOKIE?: string;
    AFFILIATE_REF_LEGACY_COOKIE?: string;
    AFFILIATE_IP_SALT?: string;
    AFFILIATE_DEV_MODE?: string;
    AFFILIATE_TERMS_VERSION?: string;
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

export interface AdminDashboardAppearance {
    brandName?: string;
    logoUrl?: string;
    stylesheets?: readonly string[];
    fontOrigins?: readonly string[];
    title?: string;
}

export type StripeReference = string | { id: string };

/** A parsed JSON request body. Untrusted: each handler checks the fields it reads. */
export type JsonObject = Record<string, any>;

/** A Stripe API object, read field by field where it is used. */
export type StripeObject = Record<string, any>;

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

