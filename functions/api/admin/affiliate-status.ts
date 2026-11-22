import { requireAdmin } from './_gate.ts';
import { readJsonObject } from '../_public.ts';
import { stripeRequest } from '../../../src/stripe.ts';
import { isLocalAffiliateDev } from '../../../src/dev.ts';
import type { AffiliateRouteContext, AffiliatesRow } from '../../../src/types.ts';
import { errorMessage } from '../../../src/errors.ts';

export async function onRequestPost({ request, env }: AffiliateRouteContext) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    const db = env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const { id, status } = await readJsonObject(request);
    if (!Number.isSafeInteger(id) || id <= 0 || !['active', 'suspended'].includes(status)) {
        return Response.json({ ok: false, error: 'An affiliate id and active or suspended status are required' }, { status: 400 });
    }

    const affiliate = await db.prepare('SELECT status, source, promo_code_id FROM affiliates WHERE id=?1').bind(id).first<Pick<AffiliatesRow, 'status' | 'source' | 'promo_code_id'>>();
    if (!affiliate || affiliate.status === 'pending') {
        return Response.json({ ok: false, error: 'Approved affiliate not found' }, { status: 404 });
    }
    const localDemo = isLocalAffiliateDev(request, env);
    if (localDemo && affiliate.source !== 'local-demo') {
        return Response.json({ ok: false, error: 'Local demo mode can only update demo partners' }, { status: 409 });
    }
    if (affiliate.promo_code_id && !localDemo && !env.STRIPE_SECRET_KEY) {
        return Response.json({ ok: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 503 });
    }

    // Suspend locally when claiming the operation. Reactivate only after
    // Stripe confirms its update. Persist the operation so retries can resume
    // after either service times out.
    const operation = await db.prepare(`
        UPDATE affiliates
        SET status_change_id=COALESCE(status_change_id, ?1), status_change_target=?2,
            session_version=session_version+CASE WHEN status='active' AND ?2='suspended' THEN 1 ELSE 0 END,
            status=CASE WHEN ?2='suspended' THEN 'suspended' ELSE status END
        WHERE id=?3 AND status IN ('active','suspended')
          AND (status_change_target=?2 OR (status_change_id IS NULL AND status!=?2))
        RETURNING status_change_id, promo_code_id
    `).bind(crypto.randomUUID(), status, id).first<Pick<AffiliatesRow, 'status_change_id' | 'promo_code_id'>>();

    if (!operation) {
        const current = await db.prepare('SELECT status, status_change_id FROM affiliates WHERE id=?1').bind(id).first<Pick<AffiliatesRow, 'status' | 'status_change_id'>>();
        if (current && current.status === status && !current.status_change_id) {
            return Response.json({ ok: true, affiliate_id: id, status });
        }
        return Response.json({ ok: false, error: 'Another status change is in progress' }, { status: 409 });
    }

    if (operation.promo_code_id && !localDemo) {
        try {
            const promo = await stripeRequest(env, `promotion_codes/${encodeURIComponent(operation.promo_code_id)}`, {
                form: { active: String(status === 'active') },
                idempotencyKey: `aff_status_${operation.status_change_id}`,
            });
            if (promo.active !== (status === 'active')) throw new Error('Stripe returned an unexpected promotion status');
        } catch (error: unknown) {
            return Response.json({ ok: false, error: `Stripe promotion update failed: ${errorMessage(error)}` }, { status: 502 });
        }
    }
    const updated = await db.prepare(`
        UPDATE affiliates SET status=?1, status_change_id=NULL, status_change_target=NULL
        WHERE id=?2 AND status_change_id=?3
    `).bind(status, id, operation.status_change_id).run();
    if (!updated.meta.changes) {
        const current = await db.prepare('SELECT status, status_change_id FROM affiliates WHERE id=?1').bind(id).first<Pick<AffiliatesRow, 'status' | 'status_change_id'>>();
        if (!current || current.status !== status || current.status_change_id) {
            return Response.json({ ok: false, error: 'Another status change is in progress' }, { status: 409 });
        }
    }
    return Response.json({ ok: true, affiliate_id: id, status });
}
