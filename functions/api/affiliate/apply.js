// Self-serve affiliate application.
//
//   POST /api/affiliate/apply  { email, name?, message?, website? }
//     Public. Inserts the applicant as a status='pending' affiliate row and
//     notifies the shop admin by email (best-effort). Honeypot: the `website`
//     field must be empty — bots fill every input. Anti-enumeration: always
//     returns 200 { success: true } once the payload is well-formed, never
//     revealing whether the email is already known (duplicate applications
//     short-circuit to the same response).
//
// Approval stays manual (POST /api/admin/affiliate-approve), which now emails
// the applicant their dashboard link.

import { notifyAdmin } from '../_email.js';

// Reject unreasonably long free-text before it reaches the DB or an email.
const MAX_MESSAGE_LENGTH = 2000;

export async function onRequestPost(context) {
    const body = await context.request.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : null;
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE_LENGTH) : null;

    // Honeypot: real users never see the `website` field (visually hidden in
    // the form). A filled value means a bot — accept and drop.
    if (body.website) return Response.json({ success: true });

    if (!email || !email.includes('@') || email.length > 254) {
        return Response.json(
            { success: false, error: 'A valid email is required' },
            { status: 400 }
        );
    }
    if (message && message.length >= MAX_MESSAGE_LENGTH) {
        return Response.json(
            { success: false, error: 'Message is too long' },
            { status: 400 }
        );
    }

    const env = context.env;
    const db = env.DB;
    if (!db) {
        return Response.json(
            { success: false, error: 'Affiliate applications are not configured' },
            { status: 503 }
        );
    }
    const normalizedEmail = email.toLowerCase();

    try {
        await db.prepare(`
            INSERT INTO affiliates (email, name, code, status, commission_pct, source, message, applied_at, created_at)
            VALUES (?1,?2,?3,'pending',20,?4,?5,?6,?6)
        `).bind(
            normalizedEmail,
            name,
            // Provisional referral slug (email local-part, sanitized). UNIQUE
            // protects against collisions; the admin can set a real code via
            // POST /api/admin/affiliates before approving if they want.
            slugFromEmail(normalizedEmail),
            'application',
            message,
            Date.now()
        ).run();
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            // Already applied (or the slug is taken). Same success body either
            // way — anti-enumeration.
            return Response.json({ success: true });
        }
        console.error('Affiliate application insert failed:', err.message);
        return Response.json(
            { success: false, error: 'Could not submit application' },
            { status: 500 }
        );
    }

    // Best-effort admin notification. Never gates the applicant's response.
    await notifyAdmin(env, {
        subject: 'New affiliate application',
        htmlContent:
            `<p><strong>Email:</strong> ${escapeHtml(normalizedEmail)}</p>` +
            `<p><strong>Name:</strong> ${escapeHtml(name || '—')}</p>` +
            `<p><strong>Message:</strong></p><p>${escapeHtml(message || '—').replace(/\n/g, '<br>')}</p>` +
            `<p>Review and approve via POST /api/admin/affiliate-approve with the affiliate id from ` +
            `<code>GET /api/admin/affiliates</code>. Approving activates their referral link and mints their promo code.</p>`,
    });

    // Acknowledge to the applicant (no email until approval — keeps the
    // pending state honest and avoids promising anything).
    return Response.json({ success: true });
}

function slugFromEmail(email) {
    return email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'affiliate';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
