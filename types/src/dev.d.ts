import type { AffiliateEnv, AffiliateRouteContext } from './types.ts';
export declare const DEMO_EMAIL = "demo@example.test";
export declare const DEMO_CODE = "local-demo";
export declare function isLocalAffiliateDev(request: Request, env: AffiliateEnv): boolean;
export declare function devInfo({ request, env }: AffiliateRouteContext): Response;
export declare function devLogin({ request, env }: AffiliateRouteContext): Promise<Response>;
export declare function devAdminLogin({ request, env }: AffiliateRouteContext): Promise<Response>;
