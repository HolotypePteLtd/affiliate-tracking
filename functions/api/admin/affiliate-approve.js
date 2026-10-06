//   POST /api/admin/affiliate-approve { id, coupon? }
//     Sets an affiliate active and mints a unique Stripe promo code under the
//     specified coupon (defaults to 'affiliate-10') tied to the affiliate's
//     ref code. Stores the promo_code_id on the affiliate row so checkout.js
//     can pre-apply the buyer discount.
//
//     Also emails the affiliate their acceptance + dashboard link (best-effort;
//     approval succeeds even if the email fails) — this is what makes the
//     self-serve apply flow work: the applicant only hears back on approval.
//
//     Phase D: also creates a Stripe Connect Express account for the affiliate
//     and stores stripe_account_id. If Connect isn't enabled on the Stripe
//     account, the approval still succeeds (affiliate is active) — the response
//     will simply omit the connect fields and include a note. The account
//     creation can be retried later.

import { requireAdmin } from './_gate.js';
import { sendEmail } from '../_email.js';

const DEFAULT_COUPON = 'affiliate-10';

export async function onRequestPost(context) {
    const gate = requireAdmin(context.env, context.request);
    if (gate) return gate;

    const env = context.env;
    const db = env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });

    const { id, coupon } = await context.request.json().catch(() => ({}));
    if (!id) {
        return Response.json({ ok: false, error: 'Affiliate id is required' }, { status: 400 });
    }

    // Look up the affiliate (must be pending — also allows re-running for
    // approved affiliates that don't have a connect account yet).
    const aff = await db.prepare(
        "SELECT id, code, email, name, commission_pct, promo_code_id FROM affiliates WHERE id=?1 AND (status='pending' OR (status='active' AND stripe_account_id IS NULL))"
    ).bind(id).first();
    if (!aff) {
        return Response.json({ ok: false, error: 'Affiliate not found or already fully approved' }, { status: 404 });
    }

    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
        return Response.json({ ok: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 500 });
    }

    // Mint the Stripe promo code under the base coupon.
    const promoCode = (aff.code + '10').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const couponName = coupon || DEFAULT_COUPON;

    let promoData = { id: aff.promo_code_id, code: promoCode };
    if (!aff.promo_code_id) {
        const promoResp = await fetch('https://api.stripe.com/v1/promotion_codes', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${stripeKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                coupon: couponName,
                code: promoCode,
                'metadata[affiliate_id]': String(aff.id),
            }),
        });
        promoData = await promoResp.json();
        if (!promoResp.ok || promoData.error) {
            return Response.json({
                ok: false,
                error: `Failed to create promo code: ${promoData.error?.message || promoResp.status}`,
            }, { status: 502 });
        }
        // Save before Connect setup so a retry doesn't mint a duplicate code.
        await db.prepare('UPDATE affiliates SET promo_code_id=?1 WHERE id=?2')
            .bind(promoData.id, aff.id).run();
    }

    // --- Phase D: Create a Connect Express account (best-effort) ---
    //
    // Stripe Connect must be enabled on the Stripe account for this to succeed.
    // If it fails (e.g. Connect not enabled, or the account already exists), we
    // log and continue — the affiliate is active and can receive manual payouts.
    let connectAccountId = null;
    let connectOnboardingUrl = null;
    try {
        const acctResp = await fetch('https://api.stripe.com/v1/accounts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${stripeKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                type: 'express',
                email: aff.email,
                'business_type': 'individual',
                'capabilities[transfers][requested]': 'true',
                'metadata[affiliate_id]': String(aff.id),
            }),
        });
        const acctData = await acctResp.json();
        if (acctResp.ok && acctData.id && acctData.id.startsWith('acct_')) {
            connectAccountId = acctData.id;

            // Generate a one-time onboarding link so the affiliate can
            // complete KYC/tax/bank at Stripe. Use the request origin —
            // NOT SITE_URL — so the link always points back to the same
            // worker (preview vs production).
            const origin = new URL(context.request.url).origin;
            const linkResp = await fetch('https://api.stripe.com/v1/account_links', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${stripeKey}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    account: connectAccountId,
                    refresh_url: `${origin}/affiliates/dashboard/`,
                    return_url: `${origin}/affiliates/dashboard/`,
                    type: 'account_onboarding',
                }),
            });
            const linkData = await linkResp.json();
            if (linkResp.ok && linkData.url) {
                connectOnboardingUrl = linkData.url;
            }
        } else {
            console.error('Connect account creation failed:', acctData.error?.message || acctResp.status);
        }
    } catch (err) {
        console.error('Connect account creation threw:', err.message);
    }

    // --- Update the affiliate row ---
    await db.prepare(
        connectAccountId
            ? "UPDATE affiliates SET status='active', promo_code_id=?1, stripe_account_id=?2 WHERE id=?3"
            : "UPDATE affiliates SET status='active', promo_code_id=?1 WHERE id=?2"
    ).bind(...(connectAccountId
        ? [promoData.id, connectAccountId, aff.id]
        : [promoData.id, aff.id]
    )).run();

    // --- Acceptance email (best-effort) ---
    // Sent after the row is active so the dashboard link works immediately.
    // Failure logs but doesn't fail the approval: the affiliate is already
    // active and the admin can resend by pointing them at /affiliates/.
    const origin = new URL(context.request.url).origin;
    if (env.BREVO_API_KEY) {
        try {
            const loginUrl = `${origin}/affiliates/`;
            await sendEmail(env.BREVO_API_KEY, {
                to: [{ email: aff.email }],
                subject: 'You\'re in — your affiliate program access',
                htmlContent: `
                    <p>Hi${aff.name ? ' ' + escapeHtml(aff.name) : ''},</p>
                    <p>Your application to the affiliate program has been approved. Here's everything you need:</p>
                    <p><strong>Your referral link:</strong><br>${origin}/?ref=${encodeURIComponent(aff.code)}</p>
                    <p><strong>Your audience discount code:</strong> ${escapeHtml(promoData.code || promoCode)} (10% off, applied automatically via your link)</p>
                    <p><strong>Your commission:</strong> ${aff.commission_pct}% of each attributed sale, paid monthly.</p>
                    <p>Sign in to your dashboard to see clicks and conversions in real time:<br><a href="${loginUrl}">${loginUrl}</a></p>
                    <p>Sign-in is passwordless — enter your email and we'll send you a one-time link.</p>
                `,
            }, env);
        } catch (err) {
            console.error('Affiliate acceptance email failed:', err.message);
        }
    }

    return Response.json({
        ok: true,
        affiliate_id: aff.id,
        promo_code: promoData.code,
        promo_code_id: promoData.id,
        ...(connectAccountId
            ? {
                stripe_account_id: connectAccountId,
                connect_onboarding_url: connectOnboardingUrl,
                connect_note: 'Share the onboarding URL with the affiliate so they can complete KYC and link a payout bank account.',
              }
            : {
                connect_note: 'Stripe Connect account could not be created. The affiliate is still active and can receive manual payouts. Check that Stripe Connect is enabled and retry via POST /api/admin/affiliate-approve.',
              }),
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
