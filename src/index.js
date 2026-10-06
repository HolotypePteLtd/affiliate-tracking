// cf-affiliate — public API.
//
// Four exports connect the library to an existing Worker (see README):
//
//   handleAffiliateApi(request, env, ctx)
//       Serves every /api/affiliate/* and /api/admin/{affiliates,
//       affiliate-approve,conversions,conversion-approve,payouts-run} route.
//       Returns a Response for its paths, null otherwise — register it BEFORE
//       your own route table; anything you serve first simply wins.
//
//   applyAffiliateRef(request, env, respond)
//       Ref middleware. Pass your asset fallthrough as `respond`; returns a
//       Response with the attribution cookie appended, or null when the URL
//       has no ?ref= (or the code is unknown) so you fall through untouched.
//
//   attachAffiliateAttribution(params, request, env)
//       Await this on your Checkout Session URLSearchParams before POSTing to
//       Stripe. Adds client_reference_id, metadata, and the buyer-discount
//       promotion code. No-op without a cookie/DB/active affiliate.
//
//   recordConversion(session, event, env)
//       Await (or ctx.waitUntil) in your webhook's paid-session branch.
//       Idempotent INSERT ... ON CONFLICT DO NOTHING; never throws.
//
// The functions/api/** handlers are imported directly so a consumer can also
// mount individual routes itself (paths unchanged from earlier releases).

export { handleAffiliateApi, affiliateRoutes } from './route.js';
export { applyAffiliateRef, refCookieName, DEFAULT_REF_COOKIE } from './ref.js';
export { attachAffiliateAttribution } from './checkout.js';
export { recordConversion } from './webhook.js';
