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

import { requireAdmin } from './_gate.ts';
import { sendEmail, escapeHtml } from '../_email.ts';
import { readJsonObject } from '../_public.ts';
import { isLocalAffiliateDev } from '../../../src/dev.ts';
import { createOnboardingLink, stripeRequest } from '../../../src/stripe.ts';

const DEFAULT_COUPON = 'affiliate-10';

async function createPromotion(env, affiliate, coupon, baseCode) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const suffix = attempt ? `X${affiliate.id.toString(36).toUpperCase()}${attempt > 1 ? attempt : ''}` : '';
        const code = baseCode + suffix;
        // An inactive Stripe code may still belong to a suspended affiliate.
        const reserved = await env.DB.prepare('SELECT id FROM affiliates WHERE promo_code=?1 COLLATE NOCASE AND id!=?2 LIMIT 1')
            .bind(code, affiliate.id).first();
        if (reserved) continue;
        try {
            const promotion = await stripeRequest(env, 'promotion_codes', {
                // Keep the original key for the original request, including
                // approvals interrupted before their promo id was saved.
                idempotencyKey: attempt
                    ? `aff_promo_retry_${affiliate.id}_${attempt}_${coupon}`
                    : `aff_promo_${affiliate.id}_${coupon}`,
                form: { coupon, code, 'metadata[affiliate_id]': String(affiliate.id) },
            });
            if (!promotion.id?.startsWith('promo_')) throw new Error('Stripe returned an invalid promotion code');
            return { id: promotion.id, code: promotion.code || code };
        } catch (error) {
            const collision = (!error.param || error.param === 'code') &&
                (['resource_already_exists', 'promotion_code_already_exists'].includes(error.code) ||
                 /promotion code.*(?:already (?:exists|in use)|must be unique)/i.test(error.message));
            if (!collision || attempt === 4) throw error;
        }
    }
    throw new Error('No available Stripe promotion code for this affiliate');
}

export async function onRequestPost(context) {
    const gate = await requireAdmin(context.env, context.request);
    if (gate) return gate;

    const env = context.env;
    const db = env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });

    const { id, coupon } = await readJsonObject(context.request);
    if (!id) {
        return Response.json({ ok: false, error: 'Affiliate id is required' }, { status: 400 });
    }

    // Look up the affiliate (must be pending — also allows re-running for
    // approved affiliates that don't have a connect account yet).
    const aff = await db.prepare(
        "SELECT id, code, email, name, status, commission_pct, promo_code_id, promo_code, source FROM affiliates WHERE id=?1 AND (status='pending' OR (status='active' AND stripe_account_id IS NULL))"
    ).bind(id).first();
    if (!aff) {
        return Response.json({ ok: false, error: 'Affiliate not found or already fully approved' }, { status: 404 });
    }

    if (isLocalAffiliateDev(context.request, env)) {
        if (aff.source !== 'local-demo') {
            return Response.json({ ok: false, error: 'Local demo mode can only approve demo partners' }, { status: 409 });
        }
        await db.prepare("UPDATE affiliates SET status='active' WHERE id=?1 AND status='pending'").bind(aff.id).run();
        return Response.json({ ok: true, affiliate_id: aff.id, demo: true });
    }

    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
        return Response.json({ ok: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 500 });
    }

    // Mint the Stripe promo code under the base coupon.
    const promoCode = (aff.code + '10').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const couponName = coupon || DEFAULT_COUPON;

    let promoData = { id: aff.promo_code_id, code: aff.promo_code || promoCode };
    if (!aff.promo_code_id) {
        try {
            promoData = await createPromotion(env, aff, couponName, promoCode);
        } catch (error) {
            return Response.json({
                ok: false,
                error: `Failed to create promo code: ${error.message}`,
            }, { status: 502 });
        }
        // Preserve the code chosen by the first request to save it.
        const saved = await db.prepare("UPDATE affiliates SET promo_code_id=?1, promo_code=?2 WHERE id=?3 AND promo_code_id IS NULL AND status IN ('pending','active')")
            .bind(promoData.id, promoData.code, aff.id).run();
        if (!saved.meta.changes) {
            const current = await db.prepare('SELECT status, promo_code_id, promo_code FROM affiliates WHERE id=?1').bind(aff.id).first();
            if (!current?.promo_code_id || current.status === 'suspended') {
                return Response.json({ ok: false, error: 'Affiliate status changed during approval' }, { status: 409 });
            }
            promoData = { id: current.promo_code_id, code: current.promo_code || promoCode };
        }
    }

    // --- Phase D: Create a Connect Express account (best-effort) ---
    //
    // Stripe Connect must be enabled on the Stripe account for this to succeed.
    // If it fails (e.g. Connect not enabled, or the account already exists), we
    // log and continue — the affiliate is active and can receive manual payouts.
    let connectAccountId = null;
    let connectOnboardingUrl = null;
    try {
        const account = await stripeRequest(env, 'accounts', {
            idempotencyKey: `aff_connect_${aff.id}`,
            form: {
                type: 'express',
                email: aff.email,
                'business_type': 'individual',
                'capabilities[transfers][requested]': 'true',
                'metadata[affiliate_id]': String(aff.id),
            },
        });
        if (!account.id?.startsWith('acct_')) throw new Error('Stripe returned an invalid Connect account');
        connectAccountId = account.id;
        connectOnboardingUrl = await createOnboardingLink(context.request, env, connectAccountId);
    } catch (err) {
        console.error('Connect setup failed:', err.message);
    }

    // --- Update the affiliate row ---
    if (connectAccountId) {
        await db.prepare('UPDATE affiliates SET stripe_account_id=?1 WHERE id=?2 AND stripe_account_id IS NULL')
            .bind(connectAccountId, aff.id).run();
    }
    const activated = await db.prepare("UPDATE affiliates SET status='active' WHERE id=?1 AND status='pending'")
        .bind(aff.id).run();

    // --- Acceptance email (best-effort, only on initial approval) ---
    // Sent after the row is active so the dashboard link works immediately.
    // Failure logs but doesn't fail the approval: the affiliate is already
    // active and the admin can resend by pointing them at /affiliates/.
    const origin = new URL(context.request.url).origin;
    if (activated.meta.changes && env.BREVO_API_KEY) {
        try {
            const loginUrl = `${origin}/affiliates/`;
            const mailRes = await sendEmail(env.BREVO_API_KEY, {
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
            if (!mailRes.ok) console.error('Affiliate acceptance email failed:', mailRes.status);
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
                connect_note: 'The affiliate can sign in and visit /api/affiliate/connect-onboarding for a fresh onboarding link.',
              }
            : {
                connect_note: 'Stripe Connect account could not be created. The affiliate is still active and can receive manual payouts. Check that Stripe Connect is enabled and retry via POST /api/admin/affiliate-approve.',
              }),
    });
}
