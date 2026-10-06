// The library's route table.
//
// handleAffiliateApi claims ONLY these paths, so a consumer already serving
// some of them (e.g. its own /api/admin/*) can keep its handler: it registers
// first, and this router never sees the request. Anything not in this table
// returns null and the consumer falls through to its normal routing.

import { onRequestPost as affLoginPost, onRequestGet as affLoginGet } from '../functions/api/affiliate/login.js';
import { onRequestPost as applyPost } from '../functions/api/affiliate/apply.js';
import { onRequestGet as affMeGet } from '../functions/api/affiliate/me.js';
import { onRequestPost as affLogoutPost } from '../functions/api/affiliate/logout.js';
import { onRequestGet as adminAffiliatesGet, onRequestPost as adminAffiliatesPost } from '../functions/api/admin/affiliates.js';
import { onRequestPost as adminAffiliateApprove } from '../functions/api/admin/affiliate-approve.js';
import { onRequestGet as adminConversionsGet } from '../functions/api/admin/conversions.js';
import { onRequestPost as adminConversionApprove } from '../functions/api/admin/conversion-approve.js';
import { onRequestPost as adminPayoutsRun } from '../functions/api/admin/payouts-run.js';

export const affiliateRoutes = [
    ['POST', '/api/affiliate/login', affLoginPost],
    ['GET', '/api/affiliate/login', affLoginGet],
    ['POST', '/api/affiliate/apply', applyPost],
    ['GET', '/api/affiliate/me', affMeGet],
    ['POST', '/api/affiliate/logout', affLogoutPost],
    ['GET', '/api/admin/affiliates', adminAffiliatesGet],
    ['POST', '/api/admin/affiliates', adminAffiliatesPost],
    ['POST', '/api/admin/affiliate-approve', adminAffiliateApprove],
    ['GET', '/api/admin/conversions', adminConversionsGet],
    ['POST', '/api/admin/conversion-approve', adminConversionApprove],
    ['POST', '/api/admin/payouts-run', adminPayoutsRun],
];

export async function handleAffiliateApi(request, env, ctx) {
    for (const [method, path, handler] of affiliateRoutes) {
        if (method === request.method && path === new URL(request.url).pathname) {
            // Handlers are Pages-Functions style; keep the same context shape.
            return handler({ request, env, ctx, params: {} });
        }
    }
    return null;
}
