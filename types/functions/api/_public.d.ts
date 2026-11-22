import type { AffiliateEnv, JsonObject } from '../../src/types.ts';
export declare function readPublicBody(request: Request): Promise<any>;
export declare function limitPublicRequest(request: Request, env: AffiliateEnv, email?: null): Promise<Response | null>;
export declare function readJsonObject(request: Request): Promise<JsonObject>;
