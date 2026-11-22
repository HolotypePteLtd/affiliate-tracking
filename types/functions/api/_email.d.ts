import type { AffiliateEnv } from '../../src/types.ts';
export declare function escapeHtml(s: unknown): string;
export declare function emailSender(env?: AffiliateEnv): {
    name: string;
    email: string;
};
export declare function adminEmail(env?: AffiliateEnv): string;
export declare function sendEmail(apiKey: string, params: Record<string, unknown>, env?: AffiliateEnv): Promise<Response>;
export declare function notifyAdmin(env: AffiliateEnv, { subject, body }: {
    subject: string;
    body: string;
}): Promise<void>;
