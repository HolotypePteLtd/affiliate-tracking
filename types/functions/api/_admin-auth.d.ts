export declare const ADMIN_SESSION_COOKIE = "__Host-aff_admin_session";
export declare function createAdminSession(secret: string, ttl?: number): Promise<string>;
export declare function readAdminSession(request: Request, secret: string): Promise<boolean>;
export declare function adminSessionCookieHeader(token: string, requestUrl: string, maxAge?: number): string;
export declare function isSameOrigin(request: Request): boolean;
