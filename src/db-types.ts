// Generated from migrations/*.sql by scripts/generate-db-types.mjs. Do not edit.

export interface AffiliatesRow {
    id: number;
    email: string;
    name: string | null;
    code: string;
    status: string;
    commission_pct: number;
    promo_code_id: string | null;
    stripe_account_id: string | null;
    created_at: number;
    source: string | null;
    message: string | null;
    applied_at: number | null;
    terms_version: string | null;
    terms_accepted_at: number | null;
    session_version: number;
    promo_code: string | null;
    status_change_id: string | null;
    status_change_target: string | null;
}

export interface ClicksRow {
    id: number;
    affiliate_id: number;
    ip_hash: string | null;
    created_at: number;
}

export interface ConversionsRow {
    id: number;
    affiliate_id: number;
    stripe_session_id: string;
    stripe_event_id: string | null;
    payment_intent: string | null;
    customer_email: string | null;
    amount_cents: number;
    commission_cents: number;
    status: string;
    created_at: number;
    paid_at: number | null;
    payout_id: number | null;
    currency: string | null;
    customer_country: string | null;
    commission_pct: number | null;
    items_json: string;
    approved_at: number | null;
}

export interface PayoutsRow {
    id: number;
    affiliate_id: number;
    amount_cents: number;
    stripe_transfer_id: string | null;
    status: string;
    created_at: number;
    batch_key: string | null;
    stripe_account_id: string | null;
    transfer_started_at: number | null;
    currency: string;
    paid_at: number | null;
}

export interface RefundedPaymentsRow {
    payment_intent: string;
}

export interface UsedAffiliateMagicLinksRow {
    jti: string;
    expires_at: number;
}
