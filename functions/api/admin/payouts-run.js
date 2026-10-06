// POST /api/admin/payouts-run { affiliateId? }
// Atomically claims approved conversions in a durable payout batch. Retries
// resume that batch with identical Stripe parameters. Only its conversions
// become paid on success; failed transfers stay pending for retry/reconciliation.
// Affiliates without Connect retain the manual bookkeeping payout behavior.

import { requireAdmin } from './_gate.js';

// Stripe can prune idempotency records after 24 hours. Stop automatic retries
// earlier so an old, ambiguous transfer cannot accidentally be sent twice.
const TRANSFER_RETRY_WINDOW = 23 * 60 * 60 * 1000;

export async function onRequestPost(context) {
    const gate = requireAdmin(context.env, context.request);
    if (gate) return gate;

    const env = context.env;
    const db = env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    if (!env.STRIPE_SECRET_KEY) {
        return Response.json({ ok: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 500 });
    }

    const { affiliateId } = await context.request.json().catch(() => ({}));
    const affiliates = (await db.prepare(`
        SELECT a.id FROM affiliates a
        WHERE (?1 IS NULL OR a.id=?1) AND (
            EXISTS (SELECT 1 FROM conversions c WHERE c.affiliate_id=a.id
                    AND c.status='approved' AND c.payout_id IS NULL)
            OR EXISTS (SELECT 1 FROM payouts p WHERE p.affiliate_id=a.id AND p.status='pending')
        )
    `).bind(affiliateId || null).all()).results || [];
    if (!affiliates.length) {
        return Response.json({ ok: false, error: 'No approved conversions found' }, { status: 404 });
    }

    const payouts = [];
    for (const aff of affiliates) {
        const batch = await claimBatch(db, aff.id);
        if (!batch) continue; // A concurrent run may have finalized the batch.
        let status = 'pending';
        let stripeTransferId = null;
        let error = null;

        if (!batch.batch_key) {
            error = 'Legacy pending payout requires manual reconciliation before another payout';
        } else if (!batch.stripe_account_id) {
            status = 'manual';
        } else {
            // Persist the first attempt time before sending money. The destination
            // and amount were snapshotted when the batch was claimed.
            await db.prepare(`
                UPDATE payouts SET transfer_started_at=COALESCE(transfer_started_at, ?1)
                WHERE id=?2
            `).bind(Date.now(), batch.id).run();
            const attempt = await db.prepare('SELECT transfer_started_at FROM payouts WHERE id=?1')
                .bind(batch.id).first();
            if (Date.now() - attempt.transfer_started_at >= TRANSFER_RETRY_WINDOW) {
                error = 'Transfer retry window expired; reconcile this payout with Stripe before proceeding';
            } else {
                try {
                    const response = await fetch('https://api.stripe.com/v1/transfers', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Idempotency-Key': `aff_transfer_${batch.batch_key}`,
                        },
                        body: new URLSearchParams({
                            amount: String(batch.amount_cents),
                            currency: 'usd',
                            destination: batch.stripe_account_id,
                            'metadata[affiliate_id]': String(batch.affiliate_id),
                            'metadata[payout_id]': String(batch.id),
                            transfer_group: `affiliate_payout_${batch.affiliate_id}`,
                        }),
                    });
                    const data = await response.json();
                    if (response.ok && data.id?.startsWith('tr_')) {
                        stripeTransferId = data.id;
                        status = 'sent';
                    } else {
                        error = data.error?.message || `Stripe transfer failed (${response.status})`;
                    }
                } catch (err) {
                    error = err.message;
                }
            }
        }

        if (status !== 'pending') {
            // Atomic finalization also makes overlapping retries harmless.
            await db.batch([
                db.prepare(`
                    UPDATE payouts SET status=?1, stripe_transfer_id=?2
                    WHERE id=?3 AND status='pending'
                `).bind(status, stripeTransferId, batch.id),
                db.prepare(`
                    UPDATE conversions SET status='paid', paid_at=?1
                    WHERE payout_id=?2 AND status='paying'
                      AND EXISTS (SELECT 1 FROM payouts WHERE id=?2 AND status IN ('sent','manual'))
                `).bind(Date.now(), batch.id),
            ]);
        } else {
            console.error(`Payout ${batch.id} remains pending:`, error);
        }
        payouts.push({
            affiliate_id: batch.affiliate_id,
            amount_cents: batch.amount_cents,
            payout_id: batch.id,
            status,
            ...(stripeTransferId ? { stripe_transfer_id: stripeTransferId } : {}),
            ...(error ? { error } : {}),
        });
    }

    const ok = payouts.every((p) => p.status !== 'pending');
    return Response.json({ ok, payouts }, { status: ok ? 200 : 502 });
}

async function claimBatch(db, affiliateId) {
    const batchKey = crypto.randomUUID();
    // D1 batch() executes these statements in one transaction. Either a new
    // batch claims the current approved set, or we resume an existing batch.
    const results = await db.batch([
        db.prepare(`
            INSERT INTO payouts (affiliate_id, amount_cents, status, created_at, batch_key, stripe_account_id)
            SELECT id, 0, 'pending', ?1, ?2, stripe_account_id FROM affiliates
            WHERE id=?3
              AND NOT EXISTS (SELECT 1 FROM payouts WHERE affiliate_id=?3 AND status='pending')
              AND (SELECT COALESCE(SUM(commission_cents),0) FROM conversions
                   WHERE affiliate_id=?3 AND status='approved' AND payout_id IS NULL) > 0
        `).bind(Date.now(), batchKey, affiliateId),
        db.prepare(`
            UPDATE conversions SET status='paying', payout_id=(SELECT id FROM payouts WHERE batch_key=?1)
            WHERE affiliate_id=?2 AND status='approved' AND payout_id IS NULL
              AND EXISTS (SELECT 1 FROM payouts WHERE batch_key=?1)
        `).bind(batchKey, affiliateId),
        db.prepare(`
            UPDATE payouts SET amount_cents=(SELECT SUM(commission_cents) FROM conversions WHERE payout_id=payouts.id)
            WHERE batch_key=?1
        `).bind(batchKey),
        db.prepare("SELECT * FROM payouts WHERE affiliate_id=?1 AND status='pending' ORDER BY id LIMIT 1")
            .bind(affiliateId),
    ]);
    return results[3].results?.[0] || null;
}
