# cf-affiliate

A self-hosted, open-source affiliate program for Cloudflare Worker + Stripe shops.
Tracks referral links, attributes conversions through Stripe Checkout Session
metadata, provides a dashboard for affiliates, and admin API for management —
all in a single Worker with one D1 database.

**No client-side JavaScript. No third-party services.** ~90 lines of glue code
to add to your existing Worker; everything else is plug-and-play.

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

# 4. Create a Stripe coupon named "affiliate-10" (10% off, duration once)
#    in the Stripe dashboard. This is the base buyer discount.

# 5. Run tests (no Stripe/D1 — pure JS unit tests)
pnpm test

# 6. Copy the handler files into your project's Worker and add the
#    four integration snippets below. Then deploy:
pnpm wrangler deploy
```

---

## Files

Copy these files into your project (same relative paths).

| Path | What |
|---|---|
| `functions/api/_affiliate-auth.js` | HMAC magic-link + session tokens |
| `functions/api/_crypto-utils.js` | Shared HMAC + constant-time compare |
| `functions/api/_email.js` | Transactional email (defaults to Brevo, configurable) |
| `functions/api/affiliate/login.js` | Rate-limited magic-link login |
| `functions/api/affiliate/me.js` | Authenticated dashboard JSON |
| `functions/api/affiliate/logout.js` | Clear session cookie |
| `functions/api/admin/_gate.js` | x-admin-token gate |
| `functions/api/admin/affiliates.js` | List + create affiliates |
| `functions/api/admin/affiliate-approve.js` | Mint promo code + Connect account |
| `functions/api/admin/conversions.js` | List conversions |
| `functions/api/admin/conversion-approve.js` | Approve/reject conversions |
| `functions/api/admin/payouts-run.js` | Stripe Transfer or manual payout |
| `tests/unit/` | 37 unit tests (crypto, auth, gate, email) |
| `migrations/0001_affiliates.sql` | Schema (4 tables, UNIQUE idempotency) |

---

## Integration

**~95% of the code is plug-and-play.** Only four integration points connect it
to your site. Add these snippets to your existing Worker.

### Integration 1 — Ref-tracking middleware (your Worker's `fetch`)

Before your static-assets fallthrough, add this block. It reads `?ref=` on any
URL, validates the code in D1, records a click, and sets the attribution cookie.

```js
// --- Affiliate ref tracking ---
const ref = url.searchParams.get("ref");
if (ref) {
  const refRes = await applyAffiliateRef(request, env, ref);
  if (refRes) return refRes;
}
// --- end ---

return env.ASSETS.fetch(request);
```

Add these helper functions anywhere in your Worker file:

```js
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

async function hashIp(ip, salt) {
  if (!ip) return null;
  const data = new TextEncoder().encode(ip + (salt || ""));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function applyAffiliateRef(request, env, code) {
  if (!env.DB) return null;
  const aff = await env.DB.prepare(
    "SELECT id, code FROM affiliates WHERE code=?1 AND status='active'"
  ).bind(code).first();
  if (!aff) return null;

  const existing = parseCookies(request.headers.get("Cookie")).holotype_ref;
  if (existing !== aff.code) {
    const ip = request.headers.get("cf-connecting-ip") || "";
    const ipHash = await hashIp(ip, env.AFFILIATE_IP_SALT);
    try {
      await env.DB.prepare(
        "INSERT INTO clicks (affiliate_id, ip_hash, created_at) VALUES (?1,?2,?3)"
      ).bind(aff.id, ipHash, Date.now()).run();
    } catch (err) {
      console.error("Affiliate click insert failed:", err.message);
    }
  }

  const assetRes = await env.ASSETS.fetch(request);
  const headers = new Headers(assetRes.headers);
  headers.append(
    "Set-Cookie",
    `holotype_ref=${aff.code}; HttpOnly; SameSite=Lax; Max-Age=2592000; Path=/`
  );
  return new Response(assetRes.body, { status: assetRes.status, headers });
}
```

Optional: `AFFILIATE_IP_SALT` for IP hashing (`wrangler secret put AFFILIATE_IP_SALT`).

### Integration 2 — Checkout attribution (your Stripe Session creation)

Wherever you POST to `https://api.stripe.com/v1/checkout/sessions`, add this
block **after** your URLSearchParams is built, **before** the fetch:

```js
// --- Affiliate attribution ---
const refCode = parseCookies(request.headers.get("Cookie")).holotype_ref;
if (refCode && env.DB) {
  const aff = await env.DB.prepare(
    "SELECT id, code, promo_code_id FROM affiliates WHERE code=?1 AND status='active'"
  ).bind(refCode).first();
  if (aff) {
    params.append("client_reference_id", aff.code);
    params.append("metadata[affiliate_id]", String(aff.id));
    params.append("metadata[affiliate_code]", aff.code);
    if (aff.promo_code_id) {
      params.append("discounts[0][promotion_code]", aff.promo_code_id);
    }
  }
}
// --- end ---
```

### Integration 3 — Webhook conversion recording (your
`checkout.session.completed` handler)

Inside your Stripe webhook handler, after confirming `payment_status` is `'paid'`
and after any idempotency check, add:

```js
// --- Affiliate conversion recording ---
try {
  const affiliateId = session.metadata?.affiliate_id;
  if (affiliateId && env.DB) {
    const aff = await env.DB.prepare(
      "SELECT commission_pct FROM affiliates WHERE id=?1"
    ).bind(affiliateId).first();
    if (aff) {
      const commission = Math.round(
        session.amount_total * aff.commission_pct / 100
      );
      await env.DB.prepare(`
        INSERT INTO conversions
          (affiliate_id, stripe_session_id, stripe_event_id, payment_intent,
           customer_email, amount_cents, commission_cents, status, created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)
        ON CONFLICT(stripe_session_id) DO NOTHING
      `).bind(
        affiliateId, session.id, event.id,
        session.payment_intent || null,
        session.customer_details?.email || null,
        session.amount_total, commission, Date.now()
      ).run();
    }
  }
} catch (err) {
  console.error("Affiliate conversion insert failed:", err.message);
}
// --- end ---
```

### Integration 4 — Route registration (your Worker entry point)

Add the imports and route tuples for the 9 affiliate API endpoints:

```js
import { onRequestPost as affLoginPost, onRequestGet as affLoginGet } from "../functions/api/affiliate/login.js";
import { onRequestGet as affMeGet } from "../functions/api/affiliate/me.js";
import { onRequestPost as affLogoutPost } from "../functions/api/affiliate/logout.js";
import { onRequestGet as adminAffiliatesGet, onRequestPost as adminAffiliatesPost } from "../functions/api/admin/affiliates.js";
import { onRequestPost as adminAffiliateApprove } from "../functions/api/admin/affiliate-approve.js";
import { onRequestGet as adminConversionsGet } from "../functions/api/admin/conversions.js";
import { onRequestPost as adminConversionApprove } from "../functions/api/admin/conversion-approve.js";
import { onRequestPost as adminPayoutsRun } from "../functions/api/admin/payouts-run.js";

const affiliateRoutes = [
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
```

---

## Admin workflow

```bash
# Create an affiliate (sends a magic-link invite email)
curl -X POST https://yoursite.com/api/admin/affiliates \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"partner@example.com"}'

# Approve them (mints promo code, creates Connect Express account)
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

## Environment vars

| Secret / Env | Where | For |
|---|---|---|
| `DB` (D1 binding) | `wrangler.toml` | Affiliate storage |
| `AFFILIATE_SESSION_SECRET` | `wrangler secret put` | HMAC signing |
| `STRIPE_SECRET_KEY` | existing | Promo codes + payouts |
| `BREVO_API_KEY` | required | Transactional email (Brevo default) |
| `EMAIL_URL` | optional | Override email API endpoint (default `https://api.brevo.com/v3/smtp/email`) |
| `EMAIL_AUTH_HEADER` | optional | Override auth header name (default `api-key`) |
| `ADMIN_TOKEN` | `wrangler secret put` | Admin API gate |
| `AFFILIATE_IP_SALT` | optional | IP hash salt |

## Tests

```bash
pnpm test        # 37 tests — pure JS, no network, no Stripe
pnpm test:watch  # re-run on file changes
```

Covers: token sign/verify with purpose scoping, tamper rejection, expiry,
admin gate (correct/wrong/missing token), constant-time comparison, HTML
escaping, cookie header construction.

## License

MIT
