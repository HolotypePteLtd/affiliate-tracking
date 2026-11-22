# cf-affiliate

A self-hosted, open-source affiliate program for Cloudflare Worker + Stripe shops.
Tracks referral links, attributes conversions through Stripe Checkout Session
metadata, provides a dashboard for affiliates, an admin API for management, and
a self-serve application endpoint — all in your existing Worker with one D1
database.

**First-party referral tracking in your Worker, with Stripe Checkout and D1.**

> This repo is published as a reference implementation and starting point for
> your own fork. **Bug-fix PRs are welcome** — I'll review and merge them.
> Feature PRs are unlikely to be reviewed. I'm not actively maintaining this
> for the broader community.

---

## How it works

```
affiliate link ?ref=nick  →  Worker reads ?ref=, validates in D1,
                              sets a first-party cookie, records one click
buyer clicks Buy          →  checkout handler reads the cookie,
                              attaches affiliate metadata + buyer discount
                              to the Stripe Checkout Session
Stripe webhook fires      →  verifies applied promotions before cookie attribution,
                              inserts an idempotent conversion row
```

No client-side snippet. No third party. One D1 database, one `AFFILIATE_SESSION_SECRET`.

---

## Setup

```bash
# 1. Create the D1 database
pnpm wrangler d1 create cf-affiliate
# → paste the returned database_id into wrangler.toml

# 2. Apply the schema migrations
pnpm wrangler d1 migrations apply DB --remote
# Or individually:
# pnpm wrangler d1 execute DB --file=migrations/0001_affiliates.sql --remote
# pnpm wrangler d1 execute DB --file=migrations/0003_dashboard_details.sql --remote
# pnpm wrangler d1 execute DB --file=migrations/0004_affiliate_terms.sql --remote
# pnpm wrangler d1 execute DB --file=migrations/0005_affiliate_operations.sql --remote
# pnpm wrangler d1 execute DB --file=migrations/0006_hold_period.sql --remote

# 3. Set secrets
pnpm wrangler secret put AFFILIATE_SESSION_SECRET
pnpm wrangler secret put STRIPE_SECRET_KEY
pnpm wrangler secret put BREVO_API_KEY   # or your email provider's key
pnpm wrangler secret put ADMIN_TOKEN
# Optional: if you're not using Brevo, set these too:
# pnpm wrangler secret put EMAIL_URL       # your provider's API endpoint
# pnpm wrangler secret put EMAIL_AUTH_HEADER  # e.g. "Authorization" for Bearer token providers
#
# Sender identity for all affiliate mail (or set EMAIL_SENDER_NAME/EMAIL_SENDER_ADDRESS
# as plain [vars] in wrangler.toml — recommended). Fallbacks are neutral placeholders.

# 4. Create a Stripe coupon named "affiliate-10" (10% off, duration once)
#    in the Stripe dashboard. This is the base buyer discount.

# 5. Run tests (Node.js 22.13+; local SQLite, no Stripe/D1 services)
pnpm test

# 6. Install the library and wire the helpers below, then deploy
pnpm add file:../cf-affiliate     # or: pnpm add github:you/cf-affiliate
pnpm wrangler deploy
```

---

## Install

```bash
pnpm add file:../cf-affiliate          # sibling checkout, edit-and-reload
pnpm add github:you/cf-affiliate#v0.2.0  # pinned
```

## Worker integration

### 1 · Route the API (`handleAffiliateApi`)

In your Worker's `fetch`, before your own route table. It serves every
`/api/affiliate/*` endpoint plus the admin endpoints and returns `null` for
anything else, so requests you already handle (your own `/api/admin/*`, for
example) simply never reach it.

```js
import { handleAffiliateApi, applyAffiliateRef } from "cf-affiliate";

const affRes = await handleAffiliateApi(request, env, ctx);
if (affRes) return affRes;
```

### 2 · Ref middleware (`applyAffiliateRef`)

Before your static-assets fallthrough. Reads `?ref=`, validates the code in
D1, records one click, and appends the attribution cookie to whatever your
site would have served anyway.

```js
const refRes = await applyAffiliateRef(request, env, () => env.ASSETS.fetch(request), ctx);
if (refRes) return refRes;

return env.ASSETS.fetch(request);
```

Optional: `AFFILIATE_IP_SALT` for IP hashing (`wrangler secret put AFFILIATE_IP_SALT`).
Passing the Worker's execution context lets the click insert finish in the
background. The three-argument form still waits for the insert.

### 3 · Checkout attribution (`attachAffiliateAttribution`)

Wherever you build the `URLSearchParams` for `POST
https://api.stripe.com/v1/checkout/sessions`, in **every** branch that creates
a session, after the params are built and before the fetch:

```js
import { attachAffiliateAttribution } from "cf-affiliate";

await attachAffiliateAttribution(params, request, env, { promoCode: body.promo_code });
```

Appends `client_reference_id` (only if you haven't set it yourself),
`metadata[affiliate_id]`, `metadata[affiliate_code]`, and — once the affiliate
has been approved — `discounts[0][promotion_code]` for the buyer discount.
With no entered code, no-op when there is no cookie, no DB binding, or no active affiliate.

The optional `promoCode` is the buyer-entered code, not a Stripe object ID.
Lookup uses this environment's Stripe key and is case-insensitive. An entered
code replaces the automatic cookie discount; discounts do not stack. Return a
recoverable checkout error for `PromotionCodeError` (`status` and `code`) and
Stripe redemption errors; do not silently discard a rejected entered code.
Stripe promotion metadata is not used to establish affiliate ownership.

### 4 · Conversion recording (`recordConversion`)

In your signed Stripe webhook handler, once payment is confirmed:

```js
import { recordConversion } from "cf-affiliate";

// Call for every paid session, even without affiliate metadata.
// Await before acknowledging so Stripe can retry verification/DB failures.
const attributedSession = await recordConversion(session, event, env);
```

Verifies the final applied Stripe promotion before inserting a commission.
An active affiliate's stored promotion ID overrides any referral cookie,
including absent/conflicting cookies. General store codes leave cookie
attribution unchanged. Removed/unapplied codes do not retain provisional
attribution; only the valid cookie captured at checkout can be the fallback.
When a new checkout's event omits discounts, the helper retrieves its final
session using `STRIPE_SECRET_KEY`. Errors propagate: return non-2xx for a retry.

Returns the attributed session, or null for an unattributed order. Pass that
session and optional purchased line items as the fourth argument to enrich the
record before email acknowledgement. Recording is idempotent by checkout
session ID; retries preserve original affiliate, money, and financial status.

### 5 · Refund and dispute recording (`recordRefund`)

Subscribe your Stripe webhook to `charge.refunded` and `charge.dispute.created`.
In the signature-verified handler, await the helper before acknowledging Stripe
so failed database writes can be retried.

```js
import { recordRefund } from "cf-affiliate";

if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
    await recordRefund(event, env);
}
```

A full or partial refund, or a new dispute, makes the entire unpaid
commission ineligible. A refund received before checkout also applies when
that checkout is recorded. Already paid commissions retain their payout
history. If a transfer may have been sent already, reconcile the batch in
the admin dashboard.

---

## Referral cookies and attribution

A successfully applied affiliate promo code takes priority over referral
cookies. Otherwise the last valid affiliate-link visit wins within a 30-day
cookie window. The host owns code-entry UI and must publish these rules in its
program terms.
Every valid referral-link visit refreshes the window; ordinary visits and
checkout do not. For HTTPS hosts, configure a protected cookie name:

```toml
[vars]
AFFILIATE_REF_COOKIE = "__Host-affiliate_ref"
AFFILIATE_REF_LEGACY_COOKIE = "affiliate_ref"
```

Referral responses use Secure, HttpOnly, SameSite=Lax, Path=/, and no
Domain. HTTP loopback development (localhost, 127.0.0.1, or [::1]) strips
the __Host- prefix automatically. The neutral default stays affiliate_ref
for existing hosts that have not changed their configuration.

The optional AFFILIATE_REF_LEGACY_COOKIE is a read-only migration fallback
used only when the current cookie is absent. Repeated cookies are decoded
and accepted only when their referral codes agree. Conflicts emit an
affiliate_ref_cookie_conflict warning containing only the cookie name,
and skip cookie attribution and the automatic affiliate discount while
checkout proceeds. Invalid, empty, conflicting, unknown or inactive
current referrals never fall back to an older legacy referral.

A fresh valid referral link sets the current cookie and expires the known
host-only root-path legacy cookie. Unknown legacy paths/domains cannot all
be cleared, but a present current cookie outranks them. Checkout never
rewrites a legacy cookie or extends its expiry. Remove the legacy setting
after the migration window when appropriate.

## Affiliate lifecycle

**Self-serve:** candidates apply via a form posting `{email, name?, message?}`
to `/api/affiliate/apply` (this repo's `examples/portal.html` is a minimal
reference implementation of the form + login UX). The endpoint
honeypots bots (`website` field must stay empty), always answers `200
{success:true}` once the payload is well-formed (anti-enumeration), and lands
the application as a `status='pending'` row with `source='application'`.

**Admin-created:** `POST /api/admin/affiliates` still works exactly as before —
it creates a pending row with `source='admin'` and emails a magic-link invite.

**Approval** (either origin): `POST /api/admin/affiliate-approve` activates the
affiliate, mints their Stripe promo code, creates the Connect Express account
when available, and now **emails the applicant their acceptance** — referral
link, discount code, commission terms, and dashboard sign-in. Approval
succeeds even if that email fails. Missing Connect accounts can be retried by
re-running approval; the existing promotion code is reused.

```bash
# Review the queue (applications have source='application' + message)
curl https://yoursite.com/api/admin/affiliates -H "x-admin-token: $ADMIN_TOKEN"

# Approve (mints promo code, creates Connect account, emails the affiliate)
curl -X POST https://yoursite.com/api/admin/affiliate-approve \
  -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"id":1}'

# Review pending conversions
curl https://yoursite.com/api/admin/conversions?status=pending \
  -H "x-admin-token: $ADMIN_TOKEN"

# Approve a conversion
curl -X POST https://yoursite.com/api/admin/conversion-approve \
  -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":1,"approved":true}'

# Run payouts (Stripe Transfer for Connect affiliates, manual for others)
curl -X POST https://yoursite.com/api/admin/payouts-run \
  -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json"
```

Payouts claim the current approved conversions atomically and move them to
`status='paying'`. A successful transfer marks only those conversions paid;
new approvals wait for the next batch. Failed transfers return HTTP 502 with
`ok:false` and remain pending. Re-running payouts resumes the same batch with
the same amount, destination, metadata, and Stripe idempotency key. Manual
payouts remain bookkeeping only and mark their batch paid without a transfer.

Automatic transfer retries stop 23 hours after the first attempt, before
Stripe may expire the idempotency record. For a pending batch, choose
**Reconcile payout** in the dashboard or POST `{"id":1}` to
`/api/admin/payouts-reconcile`. A matching Stripe transfer finalizes the
existing batch. After 24 hours, the endpoint can release a batch with no
matching transfer. Confirm that no separate payment was made, then select
the dashboard confirmation or POST `{"id":1,"action":"release"}`. The next
payout run claims the remaining approved commissions under a fresh key.
For a verified legacy transfer without attached conversions, pass the
original IDs as `conversionIds`, for example `{"id":1,"conversionIds":[4,5]}`.

### Automatic hold period (`releaseHeldConversions`)

By default every conversion waits for an admin to approve it. To approve them
automatically once refunds are unlikely, set a hold period in days and call
the helper from your Worker's `scheduled()` handler:

```toml
[vars]
AFFILIATE_HOLD_DAYS = "30"

[triggers]
crons = ["0 3 * * *"]   # once a day is enough
```

```js
import { releaseHeldConversions } from "cf-affiliate";

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(releaseHeldConversions(env));
    },
};
```

A pending conversion becomes `approved` once it is at least
`AFFILIATE_HOLD_DAYS` old, unless it was refunded or disputed (including a
refund that arrived before the checkout webhook), its affiliate is not
`active`, or the affiliate is flagged for review. Manual approve and reject
still work at any time. With `AFFILIATE_HOLD_DAYS` unset the helper does
nothing, so existing hosts keep manual approval.

Flag an affiliate whose conversions should always be reviewed by hand:

```bash
curl -X POST https://yoursite.com/api/admin/affiliate-review \
  -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":1,"review_required":true}'
```

### Partner access and onboarding

Admins can suspend or reactivate an approved partner from the dashboard or
POST `{"id":1,"status":"suspended"}` (or `"active"`) to
`/api/admin/affiliate-status`. The action updates the Stripe promotion code
as well. If Stripe times out, retry the same action. **Revoke sessions**,
also available via POST `{"id":1}` to
`/api/admin/affiliate-revoke-sessions`, invalidates existing affiliate
sessions and unredeemed links while keeping partner status.

Every magic link can be redeemed once. This release switches both HTTPS
session cookies to `__Host-` names and requires a fresh sign-in after
upgrading. HTTP loopback development continues to use unprefixed names.

Add a link to `/api/affiliate/connect-onboarding` in your affiliate dashboard
for partners with a `stripe_account_id`. The endpoint directs the signed-in
partner to a fresh single-use Stripe Account Link and also handles Stripe's
expired-link refresh redirect.

### TypeScript

The package includes declarations for the public helpers and an
`AffiliateEnv` type. Pass your Worker's generated environment and execution
context to the helpers directly.

---

## Files

| Path | What |
|---|---|
| `src/index.js` | Public API — the four exports |
| `src/route.js` | Route table + `handleAffiliateApi` |
| `src/ref.js` | Ref middleware (`applyAffiliateRef`) + cookie parsing |
| `src/checkout.js` | Checkout attribution (`attachAffiliateAttribution`) |
| `src/webhook.js` | Conversion, refund, and dispute recording |
| `functions/api/_affiliate-auth.js` | HMAC magic-link + session tokens |
| `functions/api/_crypto-utils.js` | Shared HMAC + constant-time compare |
| `functions/api/_email.js` | Transactional email (Brevo default, configurable) |
| `functions/api/affiliate/apply.js` | Self-serve application endpoint |
| `functions/api/affiliate/login.js` | Rate-limited magic-link login |
| `functions/api/affiliate/me.js` | Authenticated dashboard JSON |
| `functions/api/affiliate/logout.js` | Clear session cookie |
| `functions/api/admin/_gate.js` | x-admin-token gate |
| `functions/api/admin/affiliates.js` | List + create affiliates |
| `functions/api/admin/affiliate-approve.js` | Mint promo code + Connect account + acceptance email |
| `functions/api/admin/conversions.js` | List conversions |
| `functions/api/admin/conversion-approve.js` | Approve/reject conversions |
| `functions/api/admin/affiliate-review.js` | Always review one affiliate's conversions by hand |
| `src/hold.js` | Automatic hold period (`releaseHeldConversions`) |
| `functions/api/admin/payouts-run.js` | Stripe Transfer or manual payout |
| `functions/api/admin/payouts-reconcile.js` | Pending batch reconciliation |
| `tests/unit/` | Unit tests (crypto, auth, gate, email) |
| `migrations/0001_affiliates.sql` | Complete schema: affiliates, applications, clicks, conversions, and durable payout batches |

Handlers keep their Pages-Functions signatures (`onRequestGet`/`onRequestPost`
receiving `{request, env, ctx}`), so a consumer can also mount individual
routes itself — see `src/route.js` for the exact paths.

## Environment vars

| Secret / Env | Where | For |
|---|---|---|
| `DB` (D1 binding) | `wrangler.toml` | Affiliate storage |
| `AFFILIATE_SESSION_SECRET` | `wrangler secret put` | HMAC signing |
| `STRIPE_SECRET_KEY` | existing | Promo codes + payouts |
| `BREVO_API_KEY` | required | Transactional email (Brevo default) |
| `EMAIL_URL` | optional | Override email API endpoint (default `https://api.brevo.com/v3/smtp/email`) |
| `EMAIL_AUTH_HEADER` | optional | Override auth header name (default `api-key`) |
| `EMAIL_SENDER_NAME` | optional | From display name (default `Store`) |
| `EMAIL_SENDER_ADDRESS` | optional | From address (default `hello@example.com`) |
| `ADMIN_EMAIL` | optional | Where admin notifications go |
| `ADMIN_TOKEN` | `wrangler secret put` | Admin API gate |
| `AFFILIATE_REF_COOKIE` | optional | Attribution cookie name (default `affiliate_ref`) |
| `AFFILIATE_IP_SALT` | optional | IP hash salt |
| `AFFILIATE_HOLD_DAYS` | optional | Days before pending conversions are approved automatically (unset: manual only) |

## Tests

```bash
pnpm test        # Node.js 22.13+, local SQLite, no network/Stripe/D1 services
pnpm test:watch  # re-run on file changes
```

Covers: token sign/verify with purpose scoping, tamper rejection, admin gate,
constant-time comparison, HTML escaping, cookie headers, applications,
approval retries, referral failures, and payout failures, concurrency,
transaction rollback, and crash recovery. Handler tests execute the actual SQL
against an in-memory SQLite database with mocked Stripe and email requests.

## License

MIT

## Affiliate dashboard queries

Apply migration `0003_dashboard_details.sql` before deploying the new handlers.
`GET /api/affiliate/me` accepts `page` (default 1), `per_page` (default 100,
maximum 100), `start_date` / `end_date` (`YYYY-MM-DD`, inclusive UTC dates),
`product` (Stripe product ID), and `status` (`pending`, `approved`, `paying`,
`paid`, `refunded`). Product filters match any item in an order. Conversion
`pagination` contains `page`, `per_page`, `total`, and `total_pages`; pages past
the end resolve to the last page. Invalid query values return HTTP 400.
`payout_page` / `payout_per_page` (default 1 / 25, maximum 100) independently
page the affiliate's payout history, returned in `payouts` and
`payouts_pagination`. Customer email/address and Stripe payment/transfer IDs
are excluded from affiliate responses. Existing clicks and commission totals
remain lifetime values; clients should avoid combining different currencies.

Purchase details are snapshots: product, variant, quantity, currency, billing
country, and commission rate. Pass the full purchased line-item list as the
optional fourth argument: `recordConversion(session, event, env, lineItems)`.
Session-expanded line items are used by default. Webhook retries can enrich
missing product/country/currency details without changing money, recorded
commission rate, dates, or financial status. Historical details not recorded
remain unknown; do not infer currency or country from storefront language.
Money includes `currency_decimals` for Stripe's minor-unit representation.

`GET /api/affiliate/export` exports all matching conversions using the same
product/status/date filters. The CSV streams in bounded batches, uses safe
order/payout references, excludes customer identities, and escapes spreadsheet
formula prefixes. Both reporting endpoints require an active affiliate session.
Payout transfers remain USD-only; newly claimed foreign/unknown-currency
commissions return HTTP 409 for reconciliation instead of being paid as USD.

## Admin dashboard and local demo

The router serves a dependency-free admin dashboard at `/admin/affiliates/`.
Sign in with `ADMIN_TOKEN`; the browser receives an eight-hour signed HttpOnly,
SameSite=Strict session cookie. The token is never stored in browser storage.
Cookie-authenticated mutations require the same Origin. CLI `x-admin-token`
authentication still works. Admin endpoints deny access when the token is absent.
The dashboard includes partner creation/application approval, conversion review,
and payout history with confirmed payout actions. `AFFILIATE_PUBLIC_LIMITER`
(as in `wrangler.toml`) is required for rate-limited token sign-in.

For host branding, import `adminDashboard` from the public API and call
`adminDashboard(context, { brandName, title, logoUrl, stylesheets, fontOrigins })`
before the generic route. The UI and session logic stay shared; your Worker
supplies a same-origin logo and stylesheet URLs. External stylesheet and font
origins are allowed by the page's CSP, while scripts still require its nonce.
Without appearance options, the standalone dashboard keeps its default style.

For a consumer Worker running locally, add `ADMIN_TOKEN` and
`AFFILIATE_SESSION_SECRET` (each generated with `openssl rand -hex 32`) and
`AFFILIATE_DEV_MODE=true` to its gitignored `.dev.vars`. Apply the schema locally
and execute this package's `examples/local-demo.sql` with `--local`.
If your schema was already initialized, do not reapply the initial CREATE TABLE
statements. Local seeding is idempotent and preserves changes to demo records.

```bash
pnpm wrangler d1 migrations apply DB --local
pnpm wrangler d1 execute DB --local --file examples/local-demo.sql
pnpm wrangler dev
```

The demo has an active `demo@example.test` / `local-demo` affiliate, an applicant,
clicks, commissions, and a sample payout. The admin page includes demo sign-in
buttons. A consumer's affiliate portal can show its own demo button after
`GET /api/affiliate/dev` returns `{enabled:true}`; POST to
`/api/affiliate/dev-login` then navigate to `/affiliates/dashboard/`.
No email or Stripe keys are needed for these sign-ins. Demo partner creation
and approval skip external integrations, and payments are blocked.

Demo routes require the explicit flag and a loopback hostname; both POST routes
also require the same Origin. Never enable the flag in remote configuration.
Remove it to test normal integrations locally. The local bootstrap command
and branded affiliate page remain the consumer's responsibility.

## Terms acceptance

The host owns its program terms and signup page. After applying
`migrations/0004_affiliate_terms.sql`, set `AFFILIATE_TERMS_VERSION` to the
published version in each environment. New self-serve applications must submit
`accepted_terms: true` and a matching `terms_version`. Missing or stale
acceptance returns HTTP 400 with the current version. The new affiliate row
records `terms_version` and a server-generated `terms_accepted_at`.

Existing/admin-created accounts retain NULL acceptance; migration does not
manufacture consent. Duplicate applications never overwrite acceptance or
enrol an existing account into a newer policy. Without the setting, the public
application API stays compatible with existing hosts. Keep published policy
text, signup metadata and environment versions in sync, and retain old policy
text when changing versions. This does not automatically obtain acceptance
from existing or admin-invited affiliates.
