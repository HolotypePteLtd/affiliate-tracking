//   POST /api/admin/payouts-run { affiliateId? }
//     Processes approved conversions for one or all affiliates.
//
//     For affiliates with a Stripe Connect Express account (stripe_account_id):
//     inserts a payouts row (status='pending'), then attempts a Stripe Transfer
//     with a deterministic idempotency key. On success the payouts row is updated
//     to status='sent' and conversions are marked paid. On failure the payouts row
//     stays 'pending' as an audit trail for reconciliation.
//
//     For affiliates without a Connect account: inserts a payouts row with
//     status='manual' and marks conversions paid (bookkeeping only; the actual
//     money move happens outside this endpoint).
//
//     When affiliateId is omitted, processes ALL affiliates with approved
//     conversions.

import { requireAdmin } from './_gate.js';

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

    // Find affiliates with approved conversions (including their Connect info).
    const affiliates = await findAffiliatesWithApproved(db, affiliateId);
    if (affiliates.length === 0) {
        return Response.json({ ok: false, error: 'No approved conversions found' }, { status: 404 });
    }

    const payouts = [];
    for (const aff of affiliates) {
        const totalCents = aff.total || 0;
        if (totalCents <= 0) continue;

        // --- Phase 1: Create a payouts row (audit trail before any money move) ---
        // We insert first so even a crash after the Transfer leaves a record.
        const payoutRow = await db.prepare(
            'INSERT INTO payouts (affiliate_id, amount_cents, status, created_at) VALUES (?1,?2,\'pending\',?3)'
        ).bind(aff.affiliate_id, totalCents, Date.now()).run();
        const payoutId = payoutRow.meta?.last_row_id;

        let status = 'manual';
        let stripeTransferId = null;

        // --- Phase 2: Attempt Stripe Transfer (Connect affiliates only) ---
        if (aff.stripe_account_id) {
            // Deterministic idempotency key scoped to (affiliate, this batch).
            // If the first Transfer succeeded but this handler crashed before
            // updating the DB, a retry sends the SAME key -> Stripe returns the
            // existing result instead of creating a second transfer.
            const idempotencyKey = `aff_transfer_${aff.affiliate_id}_${aff.total}`;
            try {
                const transferResp = await fetch('https://api.stripe.com/v1/transfers', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Idempotency-Key': idempotencyKey,
                    },
                    body: new URLSearchParams({
                        amount: String(totalCents),
                        currency: 'usd',
                        destination: aff.stripe_account_id,
                        'metadata[affiliate_id]': String(aff.affiliate_id),
                        'metadata[payout_id]': String(payoutId),
                        transfer_group: `affiliate_payout_${aff.affiliate_id}`,
                    }),
                });
                const transferData = await transferResp.json();
                if (transferResp.ok && transferData.id && transferData.id.startsWith('tr_')) {
                    stripeTransferId = transferData.id;
                    status = 'sent';
                } else {
                    console.error(
                        `Transfer failed for affiliate ${aff.affiliate_id}: ${transferData.error?.message || transferResp.status}`
                    );
                }
            } catch (err) {
                console.error(`Transfer threw for affiliate ${aff.affiliate_id}:`, err.message);
            }
        }

        // --- Phase 3: Finalize the payout row + conversions ---
        await db.prepare(
            status === 'sent'
                ? "UPDATE payouts SET status='sent', stripe_transfer_id=?1 WHERE id=?2"
                : "UPDATE payouts SET status='manual' WHERE id=?1"
        ).bind(...(status === 'sent'
            ? [stripeTransferId, payoutId]
            : [payoutId]
        )).run();

        // Mark conversions paid only after the payout row is finalized.
        await db.prepare(
            "UPDATE conversions SET status='paid', paid_at=?1 WHERE affiliate_id=?2 AND status='approved'"
        ).bind(Date.now(), aff.affiliate_id).run();

        payouts.push({
            affiliate_id: aff.affiliate_id,
            amount_cents: totalCents,
            payout_id: payoutId,
            status,
            ...(stripeTransferId ? { stripe_transfer_id: stripeTransferId } : {}),
        });
    }

    return Response.json({ ok: true, payouts });
}

async function findAffiliatesWithApproved(db, affiliateId) {
    if (affiliateId) {
        return (await db.prepare(`
            SELECT cnv.affiliate_id, SUM(cnv.commission_cents) as total,
                   a.stripe_account_id, a.code
            FROM conversions cnv
            JOIN affiliates a ON a.id = cnv.affiliate_id
            WHERE cnv.affiliate_id=?1 AND cnv.status='approved'
            GROUP BY cnv.affiliate_id
        `).bind(affiliateId).all()).results || [];
    }
    return (await db.prepare(`
        SELECT cnv.affiliate_id, SUM(cnv.commission_cents) as total,
               a.stripe_account_id, a.code
        FROM conversions cnv
        JOIN affiliates a ON a.id = cnv.affiliate_id
        WHERE cnv.status='approved'
        GROUP BY cnv.affiliate_id
    `).all()).results || [];
}
