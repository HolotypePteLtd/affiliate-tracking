# cf-affiliate

A self-hosted, open-source affiliate program for Cloudflare Worker + Stripe shops.
Tracks referral links, attributes conversions through Stripe Checkout Session
metadata, provides a dashboard for affiliates, an admin API for management, and
a self-serve application endpoint — all in your existing Worker with one D1
database.

**No client-side JavaScript. No third-party services. Four function calls.**

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
Stripe webhook fires      →  reads session.metadata.affiliate_id,
                              inserts an idempotent conversion row
```

No client-side snippet. No third party. One D1 database, one `AFFILIATE_SESSION_SECRET`.

---

## Setup

```bash
# 1. Create the D1 database
pnpm wrangler d1 create cf-affiliate
# → paste the returned database_id into wrangler.toml

# 2. Apply the schema
pnpm wrangler d1 execute DB --file=migrations/0001_affiliates.sql --remote

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

# 6. Install the library and wire the four calls below, then deploy
pnpm add file:../cf-affiliate     # or: pnpm add github:you/cf-affiliate
pnpm wrangler deploy
```

---

## Install

```bash
pnpm add file:../cf-affiliate          # sibling checkout, edit-and-reload
pnpm add github:you/cf-affiliate#v0.2.0  # pinned
```

## Integration — four calls

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
const refRes = await applyAffiliateRef(request, env, () => env.ASSETS.fetch(request));
if (refRes) return refRes;

return env.ASSETS.fetch(request);
```

Optional: `AFFILIATE_IP_SALT` for IP hashing (`wrangler secret put AFFILIATE_IP_SALT`).

### 3 · Checkout attribution (`attachAffiliateAttribution`)

Wherever you build the `URLSearchParams` for `POST
https://api.stripe.com/v1/checkout/sessions`, in **every** branch that creates
a session, after the params are built and before the fetch:

```js
import { attachAffiliateAttribution } from "cf-affiliate";

await attachAffiliateAttribution(params, request, env);
```

Appends `client_reference_id` (only if you haven't set it yourself),
`metadata[affiliate_id]`, `metadata[affiliate_code]`, and — once the affiliate
has been approved — `discounts[0][promotion_code]` for the buyer discount.
No-op when there's no cookie, no DB binding, or no active affiliate.

### 4 · Conversion recording (`recordConversion`)

In your Stripe webhook handler, once `payment_status` is `'paid'`:

```js
import { recordConversion } from "cf-affiliate";

ctx.waitUntil(recordConversion(session, event, env));
```

Idempotent (`UNIQUE(stripe_session_id)` + `ON CONFLICT DO NOTHING`) and
best-effort — a failed insert logs, it never fails your webhook.

---

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
Stripe may expire the idempotency record. For expired or persistently failing
batches, inspect the payout ID and Stripe transfer metadata before changing
the database. If a transfer succeeded, finalize its payout as `sent` with the
transfer ID and mark only its `payout_id` conversions paid in one transaction.
If Stripe confirms no transfer occurred and no request is still in flight,
mark the payout `failed` and reset its conversions to `approved` with
`payout_id=NULL`; the next run creates a new batch and key.

---

## Files

| Path | What |
|---|---|
| `src/index.js` | Public API — the four exports |
| `src/route.js` | Route table + `handleAffiliateApi` |
| `src/ref.js` | Ref middleware (`applyAffiliateRef`) + cookie parsing |
| `src/checkout.js` | Checkout attribution (`attachAffiliateAttribution`) |
| `src/webhook.js` | Conversion recording (`recordConversion`) |
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
| `functions/api/admin/payouts-run.js` | Stripe Transfer or manual payout |
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
