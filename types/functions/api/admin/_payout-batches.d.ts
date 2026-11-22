import type { PayoutsRow } from '../../../src/types.ts';
export declare const TRANSFER_RETRY_WINDOW: number;
export declare const RELEASE_WINDOW: number;
export declare const transferGroup: (affiliateId: number) => string;
export type PayoutRecord = PayoutsRow & {
    has_refund: number;
};
export declare function readPayout(db: D1Database, id: number): Promise<PayoutRecord | null>;
export declare function readExistingPayout(db: D1Database, id: number): Promise<PayoutRecord>;
export declare function finalizePayout(db: D1Database, id: number, status: 'sent' | 'manual', transferId: string | null): Promise<void>;
export declare function linkLegacyConversions(db: D1Database, payout: PayoutsRow, conversionIds: number[]): Promise<boolean>;
export declare function releasePayout(db: D1Database, id: number, cutoff?: number | null): Promise<boolean>;
