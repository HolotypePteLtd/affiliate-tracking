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
import { readPublicBody, limitPublicRequest } from '../_public.js';
import {
    createMagicLink,
    verifyMagicLink,
    createSession,
    sessionCookieHeader,
} from '../_affiliate-auth.js';
import { requestIpHash } from '../../../src/ip.js';

export async function onRequestPost(context) {
    const body = await readPublicBody(context.request);
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!email || !email.includes('@') || email.length > 254) {
        return Response.json(
            { success: false, error: 'Valid email is required' },
            { status: 400 }
        );
    }
    const normalizedEmail = email.toLowerCase();
    const env = context.env;

    if (!env.DB || !env.AFFILIATE_SESSION_SECRET || !env.BREVO_API_KEY) {
        return Response.json(
            { success: false, error: 'Affiliate login is not configured' },
            { status: 503 }
        );
    }

    const limited = await limitPublicRequest(context.request, env, normalizedEmail);
    if (limited) return limited;

    // Invite-only: only active affiliates can log in. Send a link only when the
    // email matches; the response is identical either way.
    const aff = await env.DB.prepare(
        "SELECT id, session_version FROM affiliates WHERE email=?1 AND status='active'"
    )
        .bind(normalizedEmail)
        .first();

    if (aff) {
        const token = await createMagicLink(aff.id, env.AFFILIATE_SESSION_SECRET, aff.session_version);
        // Use the request origin — NOT SITE_URL — so the magic link always
        // points to the Worker that minted it (same secret -> verification
        // works). SITE_URL shouldn't be used for sign-in links; it points at
        // the production origin even from the preview deployment.
        const origin = new URL(context.request.url).origin;
        const link = `${origin}/api/affiliate/login?token=${encodeURIComponent(token)}`;
        try {
            const response = await sendEmail(env.BREVO_API_KEY, {
                to: [{ email: normalizedEmail }],
                subject: 'Your affiliate login link',
                htmlContent: `
                <p>Click the link below to sign in to your affiliate dashboard. The link expires in 15 minutes.</p>
                <p><a href="${link}">${link}</a></p>
                <p>If you didn't request this, you can ignore this email.</p>
            `,
            }, env);
            if (!response.ok) console.error('Affiliate login email failed:', response.status);
        } catch (err) {
            console.error('Affiliate login email failed:', err.message);
        }
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
    if (!token || !env.DB || !env.AFFILIATE_SESSION_SECRET) {
        return Response.redirect(home, 302);
    }

    const claims = await verifyMagicLink(token, env.AFFILIATE_SESSION_SECRET);
    if (!claims) return Response.redirect(home, 302);
    const session = await createSession(claims.sub, env.AFFILIATE_SESSION_SECRET, claims.version);
    const now = Math.floor(Date.now() / 1000);
    const [, redemption] = await env.DB.batch([
        env.DB.prepare('DELETE FROM used_affiliate_magic_links WHERE expires_at <= ?1').bind(now),
        env.DB.prepare(`INSERT OR IGNORE INTO used_affiliate_magic_links (jti, expires_at)
            SELECT ?1, ?2 FROM affiliates
            WHERE id=?3 AND status='active' AND session_version=?4 AND ?2 > ?5`)
            .bind(claims.jti, claims.exp, claims.sub, claims.version, now),
    ]);
    if (!redemption.meta.changes) return Response.redirect(home, 302);
    // Remember where the affiliate signs in from, for the self-referral check.
    const ipHash = await requestIpHash(context.request, env);
    if (ipHash) {
        try {
            await env.DB.prepare(`INSERT INTO affiliate_ip_hashes (affiliate_id, ip_hash, last_seen_at) VALUES (?1,?2,?3)
                ON CONFLICT(affiliate_id, ip_hash) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
                .bind(claims.sub, ipHash, Date.now()).run();
        } catch (err) {
            console.error('Affiliate sign-in IP record failed:', err.message);
        }
    }
    const headers = new Headers({ Location: dash });
    headers.append('Set-Cookie', sessionCookieHeader(session, context.request.url));
    return new Response(null, { status: 302, headers });
}
