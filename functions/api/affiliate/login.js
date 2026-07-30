// Affiliate login flow.
//
//   POST /api/affiliate/login   { email }
//     Looks up the affiliate by email (must be active). Mints a 15-min
//     magic-link token and emails it. Always returns { success: true } for a
//     syntactically valid email — never reveals whether an email is an
//     affiliate (invite-only, anti-enumeration). Rate-limited like the free
//     download path.
//
//   GET  /api/affiliate/login?token=…
//     Verifies the magic-link token, sets the session cookie, and 302s to
//     /affiliates/dashboard/. On any failure, 302s to /affiliates/?login=failed.

import { sendEmail } from '../_email.js';
import {
    createMagicLink,
    verifyMagicLink,
    createSession,
    sessionCookieHeader,
} from '../_affiliate-auth.js';

export async function onRequestPost(context) {
    const { email } = await context.request.json().catch(() => ({}));
    if (!email || !email.includes('@')) {
        return Response.json(
            { success: false, error: 'Valid email is required' },
            { status: 400 }
        );
    }
    const normalizedEmail = email.trim().toLowerCase();
    const env = context.env;

    if (!env.DB || !env.AFFILIATE_SESSION_SECRET || !env.BREVO_API_KEY) {
        return Response.json(
            { success: false, error: 'Affiliate login is not configured' },
            { status: 503 }
        );
    }

    // Rate-limit by client IP + email (same pattern as free-checkout).
    const limiter = env.FREE_CHECKOUT_LIMITER;
    if (limiter) {
        const clientIp = context.request.headers.get('cf-connecting-ip') || 'unknown';
        const ipRes = await limiter.limit({ key: `ip:${clientIp}` });
        const mailRes = await limiter.limit({ key: `email:${normalizedEmail}` });
        if (!ipRes.success || !mailRes.success) {
            return Response.json(
                { success: false, error: 'Too many login attempts. Please try again shortly.' },
                { status: 429, headers: { 'Retry-After': '60' } }
            );
        }
    }

    // Invite-only: only active affiliates can log in. Send a link only when the
    // email matches; the response is identical either way.
    const aff = await env.DB.prepare(
        "SELECT id, email FROM affiliates WHERE email=?1 AND status='active'"
    )
        .bind(normalizedEmail)
        .first();

    if (aff) {
        const token = await createMagicLink(aff.id, env.AFFILIATE_SESSION_SECRET);
        // Use the request origin — NOT SITE_URL — so the magic link always
        // points to the Worker that minted it (same secret -> verification
        // works). SITE_URL shouldn't be used for sign-in links; it points at
        // the production origin even from the preview deployment.
        const origin = new URL(context.request.url).origin;
        const link = `${origin}/api/affiliate/login?token=${encodeURIComponent(token)}`;
        await sendEmail(env.BREVO_API_KEY, {
            to: [{ email: normalizedEmail }],
            subject: 'Your affiliate login link',
            htmlContent: `
                <p>Click the link below to sign in to your affiliate dashboard. The link expires in 15 minutes.</p>
                <p><a href="${link}">${link}</a></p>
                <p>If you didn't request this, you can ignore this email.</p>
            `,
        });
    }

    return Response.json({ success: true });
}

export async function onRequestGet(context) {
    const env = context.env;
    const url = new URL(context.request.url);
    const origin = url.origin;
    const dash = `${origin}/affiliates/dashboard/`;
    const home = `${origin}/affiliates/?login=failed`;

    const token = url.searchParams.get('token');
    if (!token || !env.AFFILIATE_SESSION_SECRET) {
        return Response.redirect(home, 302);
    }

    const affiliateId = await verifyMagicLink(token, env.AFFILIATE_SESSION_SECRET);
    if (!affiliateId) {
        return Response.redirect(home, 302);
    }

    const session = await createSession(affiliateId, env.AFFILIATE_SESSION_SECRET);
    const headers = new Headers({ Location: dash });
    headers.append('Set-Cookie', sessionCookieHeader(session, context.request.url));
    return new Response(null, { status: 302, headers });
}
