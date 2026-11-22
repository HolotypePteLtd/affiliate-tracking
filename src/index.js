// cf-affiliate — public API.
//
// Public helpers connect the library to an existing Worker (see README):
//
//   handleAffiliateApi(request, env, ctx)
//       Serves every /api/affiliate/* and /api/admin/{affiliates,
//       affiliate-approve,conversions,conversion-approve,payouts-run} route.
//       Also serves /admin/affiliates/, admin login/logout and payout history,
//       plus explicitly enabled localhost demo sign-in routes.
//       Returns a Response for its paths, null otherwise — register it BEFORE
//       your own route table; anything you serve first simply wins.
//
//   applyAffiliateRef(request, env, respond, ctx?)
//       Ref middleware. Pass your asset fallthrough as `respond`; returns a
//       Response with the attribution cookie appended, or null when the URL
//       has no ?ref= (or the code is unknown) so you fall through untouched.
//
//   attachAffiliateAttribution(params, request, env, { promoCode }?)
//       Await this on your Checkout Session URLSearchParams before POSTing to
//       Stripe. Adds client_reference_id, metadata, and the buyer-discount
//       promotion code. An entered valid affiliate promotion overrides cookies.
//       Without a cookie or entered code, this is a no-op.
//
//   recordConversion(session, event, env)
//       Await in your webhook's paid-session branch before acknowledging Stripe.
//       Verifies the applied promotion before attribution, returns the attributed
//       session (or null), and propagates Stripe/DB failures for retries.
//
//   recordRefund(event, env)
//       Await in the verified charge.refunded and charge.dispute.created branches.
//
//   releaseHeldConversions(env, now?)
//       Call from your scheduled() handler. With AFFILIATE_HOLD_DAYS set,
//       approves pending conversions older than the hold period. Unset: no-op.
//
//   adminDashboard(context, appearance?)
//       Returns the shared admin UI with optional host branding and styles.
//       Serve before handleAffiliateApi to customize the dashboard page.
//
// The functions/api/** handlers are imported directly so a consumer can also
// mount individual routes itself (paths unchanged from earlier releases).

export { handleAffiliateApi, affiliateRoutes } from './route.js';
export { adminDashboard } from './admin-dashboard.js';
export { applyAffiliateRef, refCookieName, DEFAULT_REF_COOKIE } from './ref.js';
export { attachAffiliateAttribution } from './checkout.js';
export { PromotionCodeError } from './promotion.js';
export { recordConversion, recordRefund } from './webhook.js';
export { releaseHeldConversions } from './hold.js';
