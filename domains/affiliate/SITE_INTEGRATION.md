# Affiliate Program — Site Integration Guide

An in-house affiliate system for Cloudflare Worker + Stripe shops. **~95% of
the code is plug-and-play.** Only four integration points connect it to your
site: ref tracking, checkout attribution, webhook recording, and route
registration. This doc provides drop-in code for those four points.

---

## Architecture

```
affiliate link ?ref=nick  →  Worker reads ?ref=, validates in D1,
                              sets holotype_ref cookie, records a click (hashed IP)
buyer clicks Buy          →  checkout handler reads cookie, looks up D1,
                              attaches metadata[affiliate_id] + discount to Stripe session
Stripe checkout.completed →  webhook reads session.metadata.affiliate_id,
                              inserts idempotent conversion (ON CONFLICT DO NOTHING)
```

No client-side snippet. No third party. One D1 database, one `AFFILIATE_SESSION_SECRET`.

---

## Prerequisites

Per site, you need:

| What | How |
|---|---|
| D1 database | `wrangler d1 create` — one per environment |
| D1 binding | `[[d1_databases]]` in `wrangler.toml` — `binding = "DB"` |
| Migration | `0001_affiliates.sql` — creates the 4 tables |
| `AFFILIATE_SESSION_SECRET` | `wrangler secret put` — HMAC key for magic links + session cookies |
| Stripe coupon | e.g. `affiliate-10` (10% off) — the base coupon for buyer discounts |
| The handler files | copy from `domains/affiliate/handlers/` (listed below) |

No new KV, no new R2, no new rate-limiter binding — it shares the environment.

---

## Integration 1: Ref-tracking middleware (your Worker's fetch)

In your Worker's `fetch()` function, before the `env.ASSETS.fetch(request)` or
static-files fallthrough, add this block. It reads `?ref=` on any URL, validates
the code in D1, records one click per first-touch visitor, and sets the
attribution cookie on the response.

Place it **after API route matching, before the asset fallthrough:**

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

And add these helper functions anywhere in your Worker file (or import them
from a shared module — they're the same in every site):

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

**Optional:** `AFFILIATE_IP_SALT` — a secret salt for IP hashing (`wrangler
secret put AFFILIATE_IP_SALT`). If absent, IPs are hashed without salt.

---

## Integration 2: Checkout attribution (your Stripe Session creation)

Wherever you create a Stripe Checkout Session (i.e. the moment you POST to
`https://api.stripe.com/v1/checkout/sessions`), add this block **after** your
URLSearchParams/body is built, **before** the fetch call:

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

This reads the `holotype_ref` cookie the middleware set (Integration 1), looks
up the affiliate in D1, and attaches the tracking metadata + buyer-discount
promo code to the Stripe Session. Non-affiliate traffic (no cookie) does
nothing — the session is created exactly as before.

`parseCookies` is the same function from Integration 1 — if you already defined
it in your Worker, just use it here too.

---

## Integration 3: Webhook conversion recording (your
`checkout.session.completed` handler)

Inside your Stripe webhook handler, after you've confirmed `payment_status` is
`'paid'` (or `'no_payment_required'`) and after any idempotency check, add this
block. It reads `session.metadata.affiliate_id` (set in Integration 2) and
inserts a conversion row. The `UNIQUE(stripe_session_id)` constraint makes a
retried webhook a no-op.

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

**Best-effort only:** a DB error is logged and must not block the email flow
(the try/catch ensures that). The `ON CONFLICT` clause is the real idempotency
guard — a replayed webhook event is silently ignored.

---

## Integration 4: Route registration (your Worker entry point)

In your Worker's `src/index.js` (or wherever you register routes), add the
imports and route tuples for the 9 affiliate API endpoints. The handler files
themselves are plug-and-play (see the file list below).

**Imports:**

```js
import { onRequestPost as affLoginPost, onRequestGet as affLoginGet } from "../functions/api/affiliate/login.js";
import { onRequestGet as affMeGet } from "../functions/api/affiliate/me.js";
import { onRequestPost as affLogoutPost } from "../functions/api/affiliate/logout.js";
import { onRequestGet as adminAffiliatesGet, onRequestPost as adminAffiliatesPost } from "../functions/api/admin/affiliates.js";
import { onRequestPost as adminAffiliateApprove } from "../functions/api/admin/affiliate-approve.js";
import { onRequestGet as adminConversionsGet } from "../functions/api/admin/conversions.js";
import { onRequestPost as adminConversionApprove } from "../functions/api/admin/conversion-approve.js";
import { onRequestPost as adminPayoutsRun } from "../functions/api/admin/payouts-run.js";
```

**Route tuples** (exact-match `[method, path, handler]`):

```js
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
```

---

## Plug-and-play files

Copy these files into your project (same relative paths). They reference each
other via their existing import paths; move them as a unit.

| Path | What |
|---|---|
| `functions/api/_affiliate-auth.js` | HMAC token sign/verify, session cookie helpers |
| `functions/api/_email.js` | Brevo sendEmail, notifyAdmin, escapeHtml |
| `functions/api/affiliate/login.js` | Magic-link POST + token-exchange GET |
| `functions/api/affiliate/me.js` | GET /api/affiliate/me |
| `functions/api/affiliate/logout.js` | POST /api/affiliate/logout |
| `functions/api/admin/_gate.js` | x-admin-token gate helper |
| `functions/api/admin/affiliates.js` | GET list + POST create |
| `functions/api/admin/affiliate-approve.js` | POST approve (mint Stripe promo code) |
| `functions/api/admin/conversions.js` | GET list |
| `functions/api/admin/conversion-approve.js` | POST approve/reject |
| `functions/api/admin/payouts-run.js` | POST run manual payout |
| `migrations/0001_affiliates.sql` | Schema (run once per environment) |

**Also:** if your site has a dashboard page analogous to `/affiliates/dashboard/`,
copy `blog/content/affiliates/dashboard.md` (update the URLs inside the <script>
block if your site path differs). Same for the login form on the affiliates
landing page.

These 12+ files have zero project-specific content — no hardcoded domain, no
product names, no checkout logic. They work as-is.

---

## Environment vars + secrets summary

| Env / Secret | Where | What for |
|---|---|---|
| `DB` (D1 binding) | `wrangler.toml` | Affiliate storage |
| `AFFILIATE_SESSION_SECRET` | `wrangler secret put` | HMAC signing for magic links + session cookies |
| `STRIPE_SECRET_KEY` | already exists | Minting promo codes (admin endpoint) |
| `AFFILIATE_IP_SALT` | optional `wrangler secret put` | Salt for IP hashing in clicks table |
| (existing vars used by handlers) | | `BREVO_API_KEY`, `SITE_URL`, `ADMIN_EMAIL` for the email helpers |

---

## Provisioning checklist (per site)

- [ ] `pnpm wrangler d1 create <your-db-name>` → paste `database_id` into `wrangler.toml`
- [ ] `pnpm wrangler d1 execute DB --file=migrations/0001_affiliates.sql --remote`
- [ ] `pnpm wrangler secret put AFFILIATE_SESSION_SECRET`
- [ ] (optional) `pnpm wrangler secret put AFFILIATE_IP_SALT`
- [ ] Create a Stripe coupon: name `affiliate-10`, 10% off, duration once
- [ ] Deploy the worker
- [ ] Create your first affiliate: `curl -X POST https://yoursite.com/api/admin/affiliates -H "x-admin-token: $TOKEN" -H "Content-Type: application/json" -d '{"email":"partner@example.com"}'`
- [ ] Approve them: `curl -X POST https://yoursite.com/api/admin/affiliate-approve -H "x-admin-token: $TOKEN" -d '{"id":1}'`
- [ ] Test end-to-end: visit `https://yoursite.com/?ref=<code>` → click Buy → complete Stripe Checkout → confirm conversion recorded in admin API.

---

## What the integration points replace (inline code only)

All 9 API handler files, the schema, and the auth/email modules are plug-and-play
**without a single change**. The only thing you write is the four code blocks
above (~90 lines total). Everything else — affiliate login, session cookies,
admin CRUD, promo code minting, payout bookkeeping — is handled by the imported
handler files.

## Phase D (Stripe Connect) — when you go there

The `payouts-run.js` endpoint currently marks conversions `paid` and inserts a
`payouts` row with `status='manual'` — bookkeeping only. To automate the actual
money movement via Stripe Connect Transfers, replace `payouts-run.js` with a
version that calls `POST /v1/transfers` from the platform balance to the
affiliate's connected `stripe_account_id`. See the Phase D notes in the main
plan file for the design sketch.
