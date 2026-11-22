export declare const ADMIN_SESSION_COOKIE = "__Host-aff_admin_session";
export declare function createAdminSession(secret: any, ttl?: number): Promise<string>;
export declare function readAdminSession(request: any, secret: any): Promise<boolean>;
export declare function adminSessionCookieHeader(token: any, requestUrl: any, maxAge?: number): string;
export declare function isSameOrigin(request: any): boolean;
