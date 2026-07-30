// Admin: manage affiliates.
//
//   GET  /api/admin/affiliates          — list all affiliates with stats
//   POST /api/admin/affiliates {email, name?, code?, commissionPct?}
//                                       — create (pending), send invite email

import { requireAdmin } from './_gate.js';
import { sendEmail } from '../_email.js';
import { createMagicLink, sessionCookieHeader } from '../_affiliate-auth.js';

export async function onRequestGet(context) {
    const gate = requireAdmin(context.env, context.request);
    if (gate) return gate;

    const db = context.env.DB;
    if (!db) {
        return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    }

    const rows = await db.prepare(`
        SELECT a.id, a.email, a.name, a.code, a.status, a.commission_pct, a.created_at,
               COALESCE(c.clicks, 0) as clicks,
               COALESCE(cnv.pending, 0) as pending_conversions,
               COALESCE(cnv.approved, 0) as approved_conversions,
               COALESCE(cnv.paid, 0) as paid_conversions
        FROM affiliates a
        LEFT JOIN (SELECT affiliate_id, COUNT(*) as clicks FROM clicks GROUP BY affiliate_id) c ON c.affiliate_id = a.id
        LEFT JOIN (SELECT affiliate_id,
                          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
                          SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) as approved,
                          SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) as paid
                   FROM conversions GROUP BY affiliate_id) cnv ON cnv.affiliate_id = a.id
        ORDER BY a.created_at DESC
    `).all();

    return Response.json({ ok: true, affiliates: rows.results || [] });
}

export async function onRequestPost(context) {
    const gate = requireAdmin(context.env, context.request);
    if (gate) return gate;

    const env = context.env;
    const db = env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });

    const { email, name, code, commissionPct } = await context.request.json().catch(() => ({}));
    if (!email || !email.includes('@')) {
        return Response.json({ ok: false, error: 'Valid email is required' }, { status: 400 });
    }
    const normalizedEmail = email.trim().toLowerCase();

    // Generate a unique referral code from email if not provided.
    const refCode = (code || normalizedEmail.split('@')[0])
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '');
    if (!refCode || refCode.length < 2) {
        return Response.json({ ok: false, error: 'Referral code must be at least 2 characters' }, { status: 400 });
    }

    const pct = Math.max(1, Math.min(100, parseInt(commissionPct) || 20));

    let result;
    try {
        result = await db.prepare(
            'INSERT INTO affiliates (email, name, code, status, commission_pct, created_at) VALUES (?1,?2,?3,\'pending\',?4,?5)'
        ).bind(normalizedEmail, name || null, refCode, pct, Date.now()).run();
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return Response.json(
                { ok: false, error: 'An affiliate with this email or code already exists' },
                { status: 409 }
            );
        }
        console.error('Affiliate create failed:', err.message);
        return Response.json({ ok: false, error: 'Failed to create affiliate' }, { status: 500 });
    }

    // Send an invite email with a magic link (same login flow).
    if (env.AFFILIATE_SESSION_SECRET && env.BREVO_API_KEY) {
        const token = await createMagicLink(result.meta?.last_row_id, env.AFFILIATE_SESSION_SECRET);
        // Request origin — NOT SITE_URL — so the invite link points to the
        // Worker that created the affiliate (same secret -> verification works).
        const origin = new URL(context.request.url).origin;
        const link = `${origin}/api/affiliate/login?token=${encodeURIComponent(token)}`;
        await sendEmail(env.BREVO_API_KEY, {
            to: [{ email: normalizedEmail }],
            subject: 'You\'ve been invited to the Holotype affiliate program',
            htmlContent: `
                <p>Hi${name ? ' ' + name : ''},</p>
                <p>You've been invited to join the Holotype affiliate program. Click the link below to set up your dashboard:</p>
                <p><a href="${link}">${link}</a></p>
                <p>This link expires in 15 minutes.</p>
            `,
        });
    }

    return Response.json({ ok: true, affiliate: { id: result.meta?.last_row_id, email: normalizedEmail, code: refCode } });
}
