import { requireAdmin } from './_gate.ts';
import { readJsonObject } from '../_public.ts';
import { isLocalAffiliateDev } from '../../../src/dev.ts';
import { stripeId, stripeRequest } from '../../../src/stripe.ts';
import { finalizePayout, linkLegacyConversions, readPayout, releasePayout, transferGroup, RELEASE_WINDOW, readExistingPayout } from './_payout-batches.ts';
import type { AffiliateRouteContext, AffiliateEnv, PayoutsRow, StripeObject } from '../../../src/types.ts';
import { errorMessage } from '../../../src/errors.ts';

async function matchingTransfers(env: AffiliateEnv, payout: PayoutsRow): Promise<StripeObject[]> {
    if (payout.stripe_transfer_id) {
        return [await stripeRequest(env, `transfers/${encodeURIComponent(payout.stripe_transfer_id)}`)];
    }
    if (payout.batch_key && payout.transfer_started_at === null) return [];
    const search = new URLSearchParams({ transfer_group: transferGroup(payout.affiliate_id), limit: '100' });
    const matches: StripeObject[] = [];
    for (let page = 0; page < 10; page++) {
        const result = await stripeRequest(env, `transfers?${search}`);
        if (!Array.isArray(result.data) || typeof result.has_more !== 'boolean') {
            throw new Error('Stripe returned an invalid transfer list');
        }
        matches.push(...result.data.filter((transfer: StripeObject) => transfer.metadata?.payout_id === String(payout.id)));
        if (!result.has_more || matches.length > 1) return matches;
        const next = stripeId(result.data.at(-1));
        if (!next || next === search.get('starting_after')) break;
        search.set('starting_after', next);
    }
    throw new Error('Stripe transfer search did not finish');
}

function eligibleTransfer(transfer: StripeObject, payout: PayoutsRow) {
    return typeof transfer.id === 'string' && transfer.id.startsWith('tr_') &&
        (!payout.stripe_transfer_id || payout.stripe_transfer_id === transfer.id) &&
        transfer.metadata?.payout_id === String(payout.id) &&
        transfer.metadata.affiliate_id === String(payout.affiliate_id) &&
        transfer.amount === payout.amount_cents && transfer.currency === payout.currency &&
        (!payout.stripe_account_id || stripeId(transfer.destination) === payout.stripe_account_id) &&
        transfer.reversed === false && transfer.amount_reversed === 0;
}

const error = (message: string, status: number) => Response.json({ ok: false, error: message }, { status });

export async function onRequestPost({ request, env }: AffiliateRouteContext) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (isLocalAffiliateDev(request, env)) return error('Payments are disabled in local demo mode', 409);
    const db = env.DB;
    if (!db) return error('DB not bound', 500);
    const { id, action = 'check', conversionIds } = await readJsonObject(request);
    if (!Number.isSafeInteger(id) || id <= 0 || !['check', 'release'].includes(action)) {
        return error('A payout id and a valid reconciliation action are required', 400);
    }
    if (conversionIds !== undefined && (!Array.isArray(conversionIds) || !conversionIds.length ||
        conversionIds.length > 1000 || conversionIds.some((id: unknown) => !Number.isSafeInteger(id) || (id as number) <= 0) ||
        new Set(conversionIds).size !== conversionIds.length)) {
        return error('conversionIds must contain up to 1,000 unique conversion ids', 400);
    }
    const payout = await readPayout(db, id);
    if (!payout) return error('Payout not found', 404);
    const reply = (current: PayoutsRow) => Response.json({
        ok: true, payout_id: id, status: current.status, stripe_transfer_id: current.stripe_transfer_id,
    });
    if (payout.status !== 'pending') return reply(payout);

    let matches;
    try {
        matches = await matchingTransfers(env, payout);
    } catch (err: unknown) {
        return error(`Stripe transfer lookup failed: ${errorMessage(err)}`, 502);
    }
    if (matches.length) {
        if (matches.length !== 1 || !eligibleTransfer(matches[0], payout)) {
            return error('Stripe returned multiple, reversed, or mismatched transfers for this payout. Review the transfers before proceeding.', 409);
        }
        if (!payout.batch_key && conversionIds) {
            await linkLegacyConversions(db, payout, conversionIds);
        }
        await finalizePayout(db, id, 'sent', matches[0].id);
        const current = await readExistingPayout(db, id);
        if (current.status === 'pending') {
            return error('This legacy transfer requires the original conversionIds and a matching currency and commission total.', 409);
        }
        return reply(current);
    }

    const cutoff = Date.now() - RELEASE_WINDOW;
    const canRelease = (payout.transfer_started_at ?? payout.created_at) <= cutoff;
    if (action === 'check') {
        return Response.json({ ok: true, payout_id: id, status: 'pending', stripe_transfer_id: null, can_release: canRelease });
    }
    if (!canRelease) return error('Wait until 24 hours after the first attempt or batch creation before releasing this payout', 409);
    if (!await releasePayout(db, id, cutoff)) {
        const current = await readExistingPayout(db, id);
        if (current.status !== 'pending') return reply(current);
        return error('The payout changed during reconciliation. Check it again before releasing it.', 409);
    }
    return reply(await readExistingPayout(db, id));
}
