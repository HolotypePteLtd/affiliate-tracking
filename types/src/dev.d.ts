export declare const DEMO_EMAIL = "demo@example.test";
export declare const DEMO_CODE = "local-demo";
export declare function isLocalAffiliateDev(request: any, env: any): boolean;
export declare function devInfo({ request, env }: {
    env: any;
    request: any;
}): Response;
export declare function devLogin({ request, env }: {
    env: any;
    request: any;
}): Promise<Response>;
export declare function devAdminLogin({ request, env }: {
    env: any;
    request: any;
}): Promise<Response>;
