import type { AffiliateEnv, AffiliateExecutionContext } from './types.ts';
export declare const DEFAULT_REF_COOKIE: 'affiliate_ref';
export declare function refCookieName(env?: AffiliateEnv | null, request?: Request): string;
export declare function readAffiliateRef(request: Request, env: AffiliateEnv): string | null;
export declare function applyAffiliateRef(request: Request, env: AffiliateEnv, respond: () => Response | Promise<Response>, ctx?: AffiliateExecutionContext): Promise<Response | null>;
