export declare const TRANSFER_RETRY_WINDOW: number;
export declare const RELEASE_WINDOW: number;
export declare const transferGroup: (affiliateId: any) => string;
export declare function readPayout(db: any, id: any): any;
export declare function finalizePayout(db: any, id: any, status: any, transferId: any): Promise<void>;
export declare function linkLegacyConversions(db: any, payout: any, conversionIds: any): Promise<boolean>;
export declare function releasePayout(db: any, id: any, cutoff?: number | null): Promise<boolean>;
