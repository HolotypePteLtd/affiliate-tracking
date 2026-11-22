import type { AffiliateEnv, AffiliateExecutionContext, AffiliateRoute } from './types.ts';
export declare const affiliateRoutes: AffiliateRoute[];
export declare function handleAffiliateApi(request: Request, env: AffiliateEnv, ctx?: AffiliateExecutionContext): Promise<Response | null>;
