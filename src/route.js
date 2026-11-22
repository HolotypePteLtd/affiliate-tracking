// The library's route table.
//
// handleAffiliateApi claims ONLY these paths, so a consumer already serving
// some of them (e.g. its own /api/admin/*) can keep its handler: it registers
// first, and this router never sees the request. Anything not in this table
// returns null and the consumer falls through to its normal routing.

import { onRequestPost as affLoginPost, onRequestGet as affLoginGet } from '../functions/api/affiliate/login.js';
import { onRequestPost as applyPost } from '../functions/api/affiliate/apply.js';
import { onRequestGet as affMeGet } from '../functions/api/affiliate/me.js';
import { onRequestGet as affExportGet } from '../functions/api/affiliate/export.js';
import { onRequestPost as affLogoutPost } from '../functions/api/affiliate/logout.js';
import { onRequestGet as affConnectOnboarding } from '../functions/api/affiliate/connect-onboarding.js';
import { onRequestGet as adminAffiliatesGet, onRequestPost as adminAffiliatesPost } from '../functions/api/admin/affiliates.js';
import { onRequestPost as adminAffiliateApprove } from '../functions/api/admin/affiliate-approve.js';
import { onRequestPost as adminAffiliateStatus } from '../functions/api/admin/affiliate-status.js';
import { onRequestPost as adminAffiliateReview } from '../functions/api/admin/affiliate-review.js';
import { onRequestPost as adminAffiliateRevokeSessions } from '../functions/api/admin/affiliate-revoke-sessions.js';
import { onRequestGet as adminConversionsGet } from '../functions/api/admin/conversions.js';
import { onRequestPost as adminConversionApprove } from '../functions/api/admin/conversion-approve.js';
import { onRequestPost as adminPayoutsRun } from '../functions/api/admin/payouts-run.js';
import { onRequestPost as adminPayoutsReconcile } from '../functions/api/admin/payouts-reconcile.js';
import { onRequestGet as adminPayoutsGet } from '../functions/api/admin/payouts.js';
import { onRequestPost as adminLogin } from '../functions/api/admin/login.js';
import { onRequestPost as adminLogout } from '../functions/api/admin/logout.js';
import { devInfo, devLogin, devAdminLogin } from './dev.js';
import { adminDashboard } from './admin-dashboard.js';

export const affiliateRoutes = [
    ['GET', '/admin/affiliates', adminDashboard],
    ['GET', '/admin/affiliates/', adminDashboard],
    ['GET', '/api/affiliate/dev', devInfo],
    ['POST', '/api/affiliate/dev-login', devLogin],
    ['POST', '/api/admin/dev-login', devAdminLogin],
    ['POST', '/api/admin/login', adminLogin],
    ['POST', '/api/admin/logout', adminLogout],
    ['POST', '/api/affiliate/login', affLoginPost],
    ['GET', '/api/affiliate/login', affLoginGet],
    ['POST', '/api/affiliate/apply', applyPost],
    ['GET', '/api/affiliate/me', affMeGet],
    ['GET', '/api/affiliate/export', affExportGet],
    ['POST', '/api/affiliate/logout', affLogoutPost],
    ['GET', '/api/affiliate/connect-onboarding', affConnectOnboarding],
    ['GET', '/api/admin/affiliates', adminAffiliatesGet],
    ['POST', '/api/admin/affiliates', adminAffiliatesPost],
    ['POST', '/api/admin/affiliate-approve', adminAffiliateApprove],
    ['POST', '/api/admin/affiliate-status', adminAffiliateStatus],
    ['POST', '/api/admin/affiliate-review', adminAffiliateReview],
    ['POST', '/api/admin/affiliate-revoke-sessions', adminAffiliateRevokeSessions],
    ['GET', '/api/admin/conversions', adminConversionsGet],
    ['POST', '/api/admin/conversion-approve', adminConversionApprove],
    ['POST', '/api/admin/payouts-run', adminPayoutsRun],
    ['POST', '/api/admin/payouts-reconcile', adminPayoutsReconcile],
    ['GET', '/api/admin/payouts', adminPayoutsGet],
];

export async function handleAffiliateApi(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    for (const [method, path, handler] of affiliateRoutes) {
        if (method === request.method && path === pathname) {
            // Handlers are Pages-Functions style; keep the same context shape.
            const response = await handler({ request, env, ctx, params: {} });
            // Authentication and dashboard data must not be cached by a browser
            // or an intermediary, including error responses.
            const headers = new Headers(response.headers);
            headers.set('Cache-Control', 'no-store');
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
    }
    return null;
}
