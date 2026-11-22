import type { AffiliateEnv } from './types.ts';
export interface StripeError extends Error {
    code?: string;
    param?: string;
}
export declare function stripeRequest(env: AffiliateEnv, path: string, { form, idempotencyKey }?: {
    form?: Record<string, string>;
    idempotencyKey?: string;
}): Promise<any>;
export declare function stripeId(value: unknown): string | null;
export declare function createOnboardingLink(request: any, env: any, account: any): Promise<any>;
