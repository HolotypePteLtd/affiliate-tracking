# cf-affiliate

A self-hosted, open-source affiliate program for Cloudflare Worker + Stripe shops.
Tracks referral links, attributes conversions, provides a dashboard for affiliates,
and an admin API for management — all in a single Worker with a D1 database.

**No client-side JavaScript. No third-party services.** One D1 database, one Worker.

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

## Files

| Path | What |
|---|---|
| `functions/api/_affiliate-auth.js` | HMAC-signed magic-link tokens + session cookies |
| `functions/api/_crypto-utils.js` | Shared HMAC + constant-time compare |
| `functions/api/_email.js` | Brevo transactional email helper |
| `functions/api/affiliate/login.js` | Rate-limited magic-link login |
| `functions/api/affiliate/me.js` | Authenticated dashboard JSON API |
| `functions/api/affiliate/logout.js` | Clear session cookie |
| `functions/api/admin/_gate.js` | x-admin-token gate (constantTimeCompare) |
| `functions/api/admin/affiliates.js` | List + create affiliates |
| `functions/api/admin/affiliate-approve.js` | Mint promo code + Connect Express account |
| `functions/api/admin/conversions.js` | List conversions |
| `functions/api/admin/conversion-approve.js` | Approve/reject conversions |
| `functions/api/admin/payouts-run.js` | Stripe Transfer or manual payout |
| `migrations/0001_affiliates.sql` | Schema (4 tables, UNIQUE idempotency) |
| `domains/affiliate/SITE_INTEGRATION.md` | How to wire it into your site |
| `tests/unit/` | 37 unit tests (crypto, auth, gate, email) |

## Integration

This is **not a plugin** — it's a set of handler files you drop into your
Worker. The integration is four code snippets (~90 lines total) that connect
the affiliate system to your ref-tracking, checkout, and webhook logic.

See `domains/affiliate/SITE_INTEGRATION.md` for the exact snippets.

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
pnpm wrangler secret put BREVO_API_KEY
pnpm wrangler secret put ADMIN_TOKEN

# 4. Create a Stripe coupon named "affiliate-10" (10% off, duration once)
#    in the Stripe dashboard. This is the base buyer discount.

# 5. Run tests (no Stripe/D1 — pure JS unit tests)
pnpm test

# 6. Deploy
pnpm wrangler deploy
```

## Admin workflow

```bash
# Create an affiliate (sends a magic-link invite email)
curl -X POST https://yoursite.com/api/admin/affiliates \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"partner@example.com"}'

# Approve them (mints promo code, creates Connect account)
curl -X POST https://yoursite.com/api/admin/affiliate-approve \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":1}'

# Review pending conversions
curl https://yoursite.com/api/admin/conversions?status=pending \
  -H "x-admin-token: $ADMIN_TOKEN"

# Approve a conversion
curl -X POST https://yoursite.com/api/admin/conversion-approve \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":1,"approved":true}'

# Run payouts (Stripe Transfer for Connect affiliates, manual for others)
curl -X POST https://yoursite.com/api/admin/payouts-run \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json"
```

## Tests

```bash
pnpm test        # 37 tests, all pure JS — no Stripe, no D1, no network
pnpm test:watch  # re-run on file changes
```

Tests cover token sign/verify with purpose scoping, tamper rejection, expiry,
the admin gate (correct/wrong/missing token), constant-time comparison, HTML
escaping, and cookie header construction.

## License

MIT
