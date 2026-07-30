// cf-affiliate — Worker entry point (template).
//
// This is a STUB that imports the 9 affiliate API routes. The four integration
// snippets below show where to add affiliate logic to your existing Worker.
//
// For a full integration guide with code snippets, see:
//   domains/affiliate/SITE_INTEGRATION.md

import { onRequestPost as affLoginPost, onRequestGet as affLoginGet } from "../functions/api/affiliate/login.js";
import { onRequestGet as affMeGet } from "../functions/api/affiliate/me.js";
import { onRequestPost as affLogoutPost } from "../functions/api/affiliate/logout.js";
import { onRequestGet as adminAffiliatesGet, onRequestPost as adminAffiliatesPost } from "../functions/api/admin/affiliates.js";
import { onRequestPost as adminAffiliateApprove } from "../functions/api/admin/affiliate-approve.js";
import { onRequestGet as adminConversionsGet } from "../functions/api/admin/conversions.js";
import { onRequestPost as adminConversionApprove } from "../functions/api/admin/conversion-approve.js";
import { onRequestPost as adminPayoutsRun } from "../functions/api/admin/payouts-run.js";

const routes = [
  ["POST", "/api/affiliate/login", affLoginPost],
  ["GET",  "/api/affiliate/login", affLoginGet],
  ["GET",  "/api/affiliate/me", affMeGet],
  ["POST", "/api/affiliate/logout", affLogoutPost],
  ["GET",  "/api/admin/affiliates", adminAffiliatesGet],
  ["POST", "/api/admin/affiliates", adminAffiliatesPost],
  ["POST", "/api/admin/affiliate-approve", adminAffiliateApprove],
  ["GET",  "/api/admin/conversions", adminConversionsGet],
  ["POST", "/api/admin/conversion-approve", adminConversionApprove],
  ["POST", "/api/admin/payouts-run", adminPayoutsRun],
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -------------------------------------------------------------------
    // INTEGRATION 1: Ref-tracking middleware
    // Before the asset fallthrough, read ?ref= and set a first-party
    // attribution cookie. See SITE_INTEGRATION.md for the code snippet.
    // -------------------------------------------------------------------
    // if (url.searchParams.get("ref")) { ... applyAffiliateRef(...) ... }


    // -------------------------------------------------------------------
    // Route matching for affiliate API endpoints
    // -------------------------------------------------------------------
    for (const [method, path, handler] of routes) {
      if (method === request.method && path === url.pathname) {
        return handler({ request, env, ctx, params: {} });
      }
    }

    // -------------------------------------------------------------------
    // Your existing site logic goes here:
    //   - Stripe Checkout Session creation (INTEGRATION 2)
    //   - Stripe webhook handler (INTEGRATION 3)
    //   - Static assets / page serving
    // -------------------------------------------------------------------
    return new Response("cf-affiliate worker running", { status: 200 });
  },
};
