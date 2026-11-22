import type { PayoutsRow } from '../../../src/types.ts';
export const TRANSFER_RETRY_WINDOW = 23 * 60 * 60 * 1000;
// Allow in-flight Stripe requests to finish before releasing an old batch.
export const RELEASE_WINDOW = 24 * 60 * 60 * 1000;

export const transferGroup = (affiliateId: number) => `affiliate_payout_${affiliateId}`;

export type PayoutRecord = PayoutsRow & { has_refund: number };

export function readPayout(db: D1Database, id: number): Promise<PayoutRecord | null> {
    return db.prepare(`SELECT p.*, EXISTS (
        SELECT 1 FROM conversions WHERE payout_id=p.id AND status='refunded'
    ) AS has_refund FROM payouts p WHERE p.id=?1`).bind(id).first<PayoutRecord>();
}

// Re-read a payout this run has just written. Payouts are never deleted.
export async function readExistingPayout(db: D1Database, id: number): Promise<PayoutRecord> {
    const payout = await readPayout(db, id);
    if (!payout) throw new Error(`Payout ${id} not found after writing it`);
    return payout;
}

export async function finalizePayout(db: D1Database, id: number, status: 'sent' | 'manual', transferId: string | null) {
    await db.batch([
        db.prepare(`
            UPDATE payouts SET status=?1, stripe_transfer_id=?2, paid_at=COALESCE(paid_at,?4)
            WHERE id=?3 AND status='pending'
              AND (?1='sent' OR NOT EXISTS (
                  SELECT 1 FROM conversions WHERE payout_id=?3 AND status='refunded'))
              AND (batch_key IS NOT NULL OR amount_cents=(SELECT SUM(commission_cents)
                  FROM conversions WHERE payout_id=?3 AND status IN ('paying','refunded')))
        `).bind(status, transferId, id, Date.now()),
        db.prepare(`
            UPDATE conversions SET status=CASE WHEN status='paying' THEN 'paid' ELSE status END, paid_at=?1
            WHERE payout_id=?2 AND status IN ('paying','refunded')
              AND EXISTS (SELECT 1 FROM payouts WHERE id=?2 AND status IN ('sent','manual'))
              AND paid_at IS NULL
        `).bind(Date.now(), id),
    ]);
}

// Older runners could send a transfer without first claiming its conversions.
// Only the admin can identify that set. Verify the entire set before claiming it.
export async function linkLegacyConversions(db: D1Database, payout: PayoutsRow, conversionIds: number[]) {
    const conversions = `SELECT id, commission_cents FROM conversions
        WHERE id IN (SELECT value FROM json_each(?3)) AND affiliate_id=?2
          AND status IN ('approved','refunded') AND payout_id IS NULL AND (currency=?4 OR currency IS NULL)`;
    const result = await db.prepare(`
        WITH selected AS MATERIALIZED (${conversions})
        UPDATE conversions SET payout_id=?1, status=CASE WHEN status='approved' THEN 'paying' ELSE status END
        WHERE id IN (SELECT id FROM selected)
          AND EXISTS (SELECT 1 FROM payouts WHERE id=?1 AND status='pending' AND batch_key IS NULL)
          AND NOT EXISTS (SELECT 1 FROM conversions WHERE payout_id=?1)
          AND (SELECT COUNT(*) FROM selected)=json_array_length(?3)
          AND (SELECT SUM(commission_cents) FROM selected)=?5
    `).bind(payout.id, payout.affiliate_id, JSON.stringify(conversionIds), payout.currency, payout.amount_cents).run();
    return Boolean(result.meta.changes);
}

// Without a cutoff, release only a refunded batch that was never attempted.
// With a cutoff the caller has already checked Stripe for this payout.
export async function releasePayout(db: D1Database, id: number, cutoff: number | null = null) {
    const [payout] = await db.batch([
        db.prepare(`UPDATE payouts SET status='failed'
            WHERE id=?1 AND status='pending' AND stripe_transfer_id IS NULL
              AND ((?2 IS NULL AND batch_key IS NOT NULL AND transfer_started_at IS NULL AND EXISTS (
                    SELECT 1 FROM conversions WHERE payout_id=?1 AND status='refunded'))
                OR (?2 IS NOT NULL AND COALESCE(transfer_started_at,created_at) <= ?2))
        `).bind(id, cutoff),
        db.prepare(`UPDATE conversions SET payout_id=NULL,
            status=CASE WHEN status='paying' THEN 'approved' ELSE status END
            WHERE payout_id=?1 AND status IN ('paying','refunded')
              AND EXISTS (SELECT 1 FROM payouts WHERE id=?1 AND status='failed')
        `).bind(id),
    ]);
    return Boolean(payout.meta.changes);
}
