// Self-serve affiliate application.
//
//   POST /api/affiliate/apply  { email, name?, message?, website?, accepted_terms?, terms_version? }
//     Public. Inserts the applicant as a status='pending' affiliate row and
//     notifies the shop admin by email (best-effort). Honeypot: the `website`
//     field must be empty — bots fill every input. Anti-enumeration: always
//     returns 200 { success: true } once the payload is well-formed, never
//     revealing whether the email is already known (duplicate applications
//     short-circuit to the same response).
//
// Approval stays manual (POST /api/admin/affiliate-approve), which now emails
// the applicant their dashboard link.

import { notifyAdmin, escapeHtml } from '../_email.ts';
import { readPublicBody, limitPublicRequest } from '../_public.ts';
import type { AffiliateRouteContext } from '../../../src/types.ts';
import { errorMessage } from '../../../src/errors.ts';

// Reject unreasonably long free-text before it reaches the DB or an email.
const MAX_MESSAGE_LENGTH = 2000;

export async function onRequestPost(context: AffiliateRouteContext) {
    const body = await readPublicBody(context.request);
    if (!body) {
        return Response.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : null;
    const rawMessage = typeof body.message === 'string' ? body.message.trim() : null;

    // Honeypot: real users never see the `website` field (visually hidden in
    // the form). A filled value means a bot — accept and drop.
    if (body.website) return Response.json({ success: true });

    if (!email || !email.includes('@') || email.length > 254) {
        return Response.json(
            { success: false, error: 'A valid email is required' },
            { status: 400 }
        );
    }
    if (rawMessage && rawMessage.length > MAX_MESSAGE_LENGTH) {
        return Response.json(
            { success: false, error: 'Message is too long' },
            { status: 400 }
        );
    }
    const message = rawMessage;

    const env = context.env;
    // The host owns the terms and their version. Opt in after applying 0004;
    // hosts without a configured policy keep the existing application API.
    const termsVersion = typeof env.AFFILIATE_TERMS_VERSION === 'string' ? env.AFFILIATE_TERMS_VERSION.trim() : '';
    if (termsVersion && (body.accepted_terms !== true || body.terms_version !== termsVersion)) {
        return Response.json({ success: false, error: 'Please accept the current affiliate terms before applying.',
            terms_version: termsVersion }, { status: 400 });
    }
    const normalizedEmail = email.toLowerCase();
    const limited = await limitPublicRequest(context.request, env, normalizedEmail);
    if (limited) return limited;

    const db = env.DB;
    if (!db) {
        return Response.json(
            { success: false, error: 'Affiliate applications are not configured' },
            { status: 503 }
        );
    }

    try {
        let inserted = false;
        for (let attempt = 0; attempt < 5; attempt++) {
            const code = attempt === 0 ? slugFromEmail(normalizedEmail)
                : `${slugFromEmail(normalizedEmail)}-${crypto.randomUUID()}`;
            try {
                const result = await db.prepare(`
                    INSERT INTO affiliates (email, name, code, status, commission_pct, source, message, applied_at, created_at${termsVersion ? ', terms_version, terms_accepted_at' : ''})
                    VALUES (?1,?2,?3,'pending',20,?4,?5,?6,?6${termsVersion ? ',?7,?6' : ''})
                    ON CONFLICT(email) DO NOTHING
                `).bind(normalizedEmail, name, code, 'application', message, Date.now(), ...(termsVersion ? [termsVersion] : [])).run();
                if (!result.meta?.changes) return Response.json({ success: true });
                inserted = true;
                break;
            } catch (err: unknown) {
                if (!errorMessage(err)?.includes('UNIQUE') || attempt === 4) throw err;
            }
        }
        if (!inserted) throw new Error('Could not allocate a referral code');
    } catch (err: unknown) {
        console.error('Affiliate application insert failed:', errorMessage(err));
        return Response.json(
            { success: false, error: 'Could not submit application' },
            { status: 500 }
        );
    }

    // Best-effort admin notification. Never gates the applicant's response.
    const dashboardUrl = new URL('/admin/affiliates/', context.request.url).href;
    await notifyAdmin(env, {
        subject: 'New affiliate application',
        body:
            `<p><strong>Email:</strong> ${escapeHtml(normalizedEmail)}</p>` +
            `<p><strong>Name:</strong> ${escapeHtml(name || '—')}</p>` +
            `<p><strong>Message:</strong></p><p>${escapeHtml(message || '—').replace(/\n/g, '<br>')}</p>` +
            `<p><a href="${escapeHtml(dashboardUrl)}">Review application in the admin dashboard</a></p>` +
            `<p>Sign in to review and approve this application. Approval activates the partner's referral link and promo code.</p>`,
    });

    // Acknowledge to the applicant (no email until approval — keeps the
    // pending state honest and avoids promising anything).
    return Response.json({ success: true });
}

function slugFromEmail(email: string) {
    return email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'affiliate';
}
