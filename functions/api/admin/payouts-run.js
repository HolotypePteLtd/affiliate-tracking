// POST /api/admin/payouts-run { affiliateId? }
// Atomically claims approved conversions in a durable payout batch. Retries
// resume that batch with identical Stripe parameters. Only its conversions
// become paid on success; failed transfers stay pending for retry/reconciliation.
// Affiliates without Connect retain the manual bookkeeping payout behavior.

import { requireAdmin } from './_gate.js';
import { readJsonObject } from '../_public.js';
import { isLocalAffiliateDev } from '../../../src/dev.js';
import { stripeRequest } from '../../../src/stripe.js';
import { payoutCurrency, settleApprovedCommissions } from '../../../src/settlement.js';
import { finalizePayout, readPayout, releasePayout, transferGroup, TRANSFER_RETRY_WINDOW } from './_payout-batches.js';

export async function onRequestPost(context) {
    const gate = await requireAdmin(context.env, context.request);
    if (gate) return gate;

    const env = context.env;
    if (isLocalAffiliateDev(context.request, env)) {
        return Response.json({ ok: false, error: 'Payments are disabled in local demo mode' }, { status: 409 });
    }
    const db = env.DB;
    if (!db) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    if (!env.STRIPE_SECRET_KEY) {
        return Response.json({ ok: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 500 });
    }

    const { affiliateId } = await readJsonObject(context.request);
    // Payouts are sent in the platform's currency. Commissions in other
    // currencies are converted at the rate Stripe settled their sale at;
    // any that can't be (unknown currency, no settled charge) block the run.
    let currency;
    try {
        currency = payoutCurrency(env);
        await settleApprovedCommissions(env, affiliateId || null);
    } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
    }
    const unsupported = await db.prepare(`SELECT id FROM conversions
        WHERE status='approved' AND payout_id IS NULL AND (?1 IS NULL OR affiliate_id=?1)
          AND (payout_cents IS NULL OR payout_currency IS NULL OR payout_currency!=?2) LIMIT 1`).bind(affiliateId || null, currency).first();
    if (unsupported) {
        return Response.json({ ok: false, error: `Some commissions could not be converted to ${currency.toUpperCase()} and require reconciliation before payouts` }, { status: 409 });
    }
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
        const batch = await claimBatch(db, aff.id, currency);
        if (!batch) continue; // A concurrent run may have finalized the batch.
        let error = await sendBatch(env, batch, currency);
        let current = await readPayout(db, batch.id);
        if (current.status === 'pending' && current.has_refund) {
            if (await releasePayout(db, batch.id)) {
                error = 'A conversion was refunded before sending. Run payouts again for the remaining approved conversions.';
            } else {
                error = 'A conversion was refunded after a transfer attempt. Reconcile this payout with Stripe.';
            }
            current = await readPayout(db, batch.id);
        }
        if (current.status === 'pending') console.error(`Payout ${batch.id} remains pending:`, error);
        payouts.push({
            affiliate_id: batch.affiliate_id,
            amount_cents: batch.amount_cents,
            payout_id: batch.id,
            status: current.status,
            ...(current.stripe_transfer_id ? { stripe_transfer_id: current.stripe_transfer_id } : {}),
            ...(error && ['pending', 'failed'].includes(current.status) ? { error } : {}),
        });
    }

    const ok = payouts.every((p) => ['sent', 'manual'].includes(p.status));
    return Response.json({ ok, payouts }, { status: ok ? 200 : 502 });
}

async function sendBatch(env, batch, currency) {
    if (!batch.batch_key) return 'Legacy pending payout requires reconciliation before another payout';
    if (batch.currency !== currency) return `A pending ${String(batch.currency).toUpperCase()} payout requires reconciliation`;
    if (!Number.isFinite(batch.amount_cents) || batch.amount_cents <= 0) {
        return 'Pending payout has non-positive amount and requires reconciliation';
    }

    const db = env.DB;
    if (!batch.stripe_account_id) {
        await finalizePayout(db, batch.id, 'manual', null);
        return null;
    }
    const now = Date.now();
    // Reserving the attempt and checking refunds use the same write. After
    // reservation a webhook can block retries, but Stripe may already be in flight.
    const attempt = await db.prepare(`
        UPDATE payouts SET transfer_started_at=COALESCE(transfer_started_at, ?1)
        WHERE id=?2 AND status='pending' AND stripe_transfer_id IS NULL
          AND (transfer_started_at IS NULL OR transfer_started_at>?3)
          AND NOT EXISTS (SELECT 1 FROM conversions WHERE payout_id=?2 AND status='refunded')
        RETURNING id
    `).bind(now, batch.id, now - TRANSFER_RETRY_WINDOW).first();
    if (!attempt) return 'Transfer unavailable; reconcile this payout with Stripe before proceeding';

    let transfer;
    try {
        transfer = await stripeRequest(env, 'transfers', {
            idempotencyKey: `aff_transfer_${batch.batch_key}`,
            form: {
                amount: String(batch.amount_cents),
                currency: batch.currency,
                destination: batch.stripe_account_id,
                'metadata[affiliate_id]': String(batch.affiliate_id),
                'metadata[payout_id]': String(batch.id),
                transfer_group: transferGroup(batch.affiliate_id),
            },
        });
        if (!transfer.id?.startsWith('tr_')) throw new Error('Stripe returned an invalid transfer ID');
    } catch (error) {
        return error.message;
    }
    await finalizePayout(db, batch.id, 'sent', transfer.id);
    return null;
}

async function claimBatch(db, affiliateId, currency) {
    const batchKey = crypto.randomUUID();
    // D1 batch() executes these statements in one transaction. Either a new
    // batch claims the current approved set, or we resume an existing batch.
    const results = await db.batch([
        db.prepare(`
            INSERT INTO payouts (affiliate_id, amount_cents, status, created_at, batch_key, stripe_account_id, currency)
            SELECT id, 0, 'pending', ?1, ?2, stripe_account_id, ?4 FROM affiliates
            WHERE id=?3
              AND NOT EXISTS (SELECT 1 FROM payouts WHERE affiliate_id=?3 AND status='pending')
              AND (SELECT COALESCE(SUM(payout_cents),0) FROM conversions
                   WHERE affiliate_id=?3 AND status='approved' AND payout_id IS NULL AND payout_currency=?4) > 0
        `).bind(Date.now(), batchKey, affiliateId, currency),
        db.prepare(`
            UPDATE conversions SET status='paying', payout_id=(SELECT id FROM payouts WHERE batch_key=?1)
            WHERE affiliate_id=?2 AND status='approved' AND payout_id IS NULL AND payout_currency=?3
              AND payout_cents IS NOT NULL AND EXISTS (SELECT 1 FROM payouts WHERE batch_key=?1)
        `).bind(batchKey, affiliateId, currency),
        db.prepare(`
            UPDATE payouts SET amount_cents=(SELECT SUM(payout_cents) FROM conversions WHERE payout_id=payouts.id)
            WHERE batch_key=?1
        `).bind(batchKey),
        db.prepare("SELECT * FROM payouts WHERE affiliate_id=?1 AND status='pending' ORDER BY id LIMIT 1")
            .bind(affiliateId),
    ]);
    return results[3].results?.[0] || null;
}
