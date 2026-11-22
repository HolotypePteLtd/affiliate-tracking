import type { AffiliateEnv, CheckoutLineItem, CheckoutSession, StripeEvent } from './types.ts';
export declare function recordConversion<T extends CheckoutSession>(input: T | null | undefined, event: StripeEvent | null | undefined, env: AffiliateEnv, lineItems?: readonly CheckoutLineItem[] | null): Promise<(Omit<T, 'metadata'> & {
    metadata: Record<string, string>;
}) | null>;
/** Records a verified refund or dispute webhook and returns the number of conversions updated. */
export declare function recordRefund(event: StripeEvent | null | undefined, env: AffiliateEnv): Promise<number>;
