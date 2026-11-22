// Commission rules.
//
// For each item sold, the most specific active rule wins:
//   1. this affiliate + this product    2. this product (any affiliate)
//   3. this affiliate (any product)     4. every affiliate and product
// and with no rule at all, affiliates.commission_pct, as before. Among rules
// equally specific, the tier with the highest min_monthly_sales the affiliate
// has reached this calendar month (UTC) applies. A percent rule pays a share
// of what the item sold for after discounts; a fixed rule pays fixed_cents
// per unit, only for sales in its currency. A cap limits what one customer
// can earn the affiliate under that rule, across all their purchases.
//
// The rules applied are stored with the conversion (commission_detail), so
// changing a rule later never changes what was already earned.

const SPECIFICITY = rule => (rule.affiliate_id !== null ? 1 : 0) + (rule.product_id !== null ? 2 : 0);

function monthStart(timestamp) {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function pickRule(rules, { affiliateId, productIds, salesThisMonth }) {
    const matching = rules.filter(rule =>
        (rule.affiliate_id === null || rule.affiliate_id === affiliateId) &&
        (rule.product_id === null || productIds.includes(rule.product_id)) &&
        rule.min_monthly_sales <= salesThisMonth);
    matching.sort((a, b) => SPECIFICITY(b) - SPECIFICITY(a) || b.min_monthly_sales - a.min_monthly_sales ||
        (a.created_at - b.created_at) || String(a.id).localeCompare(String(b.id)));
    return matching[0] || null;
}

function ruleCommission(rule, baseCents, quantity, currency) {
    if (rule.kind === 'percent') return Math.round(baseCents * rule.percent / 100);
    if (rule.kind === 'fixed') return rule.currency === currency ? rule.fixed_cents * quantity : 0;
    return 0;
}

// items: [{ product_id, price_id, quantity, amount_cents }] (amount after discounts).
export async function computeCommission(env, { affiliate, amountCents, currency, items, customerEmail, at }) {
    const { results: rules } = await env.DB.prepare(`SELECT * FROM commission_rules
        WHERE active=1 AND (affiliate_id IS NULL OR affiliate_id=?1)`).bind(affiliate.id).all();
    if (!rules?.length) {
        return { commission: Math.round(amountCents * affiliate.commission_pct / 100), pct: affiliate.commission_pct, detail: null };
    }
    const sales = await env.DB.prepare(`SELECT COUNT(*) AS n FROM conversions
        WHERE affiliate_id=?1 AND status!='refunded' AND bonus_note IS NULL AND created_at>=?2 AND created_at<=?3`)
        .bind(affiliate.id, monthStart(at), at).first();
    const salesThisMonth = sales?.n || 0;
    // Price the order per item when Stripe sent item amounts that add up;
    // otherwise as one line, where only rules without a product can apply.
    const priced = items.length && items.every(item => Number.isSafeInteger(item.amount_cents)) &&
        items.reduce((sum, item) => sum + item.amount_cents, 0) === amountCents;
    const lines = priced ? items : [{ product_id: null, price_id: null, quantity: 1, amount_cents: amountCents }];

    const detail = [];
    for (const line of lines) {
        const productIds = [line.product_id, line.price_id].filter(Boolean);
        const rule = pickRule(rules, { affiliateId: affiliate.id, productIds, salesThisMonth });
        let commission = rule ? ruleCommission(rule, line.amount_cents, line.quantity || 1, currency)
            : Math.round(line.amount_cents * affiliate.commission_pct / 100);
        if (rule?.cap_per_customer_cents !== null && rule?.cap_per_customer_cents !== undefined && customerEmail) {
            const earned = await env.DB.prepare(`SELECT COALESCE(SUM(json_extract(d.value,'$.commission_cents')),0) AS cents
                FROM conversions c, json_each(c.commission_detail) d
                WHERE c.affiliate_id=?1 AND c.status!='refunded' AND lower(c.customer_email)=lower(?2)
                  AND json_extract(d.value,'$.rule_id')=?3`).bind(affiliate.id, customerEmail, rule.id).first();
            const alreadyInOrder = detail.filter(d => d.rule_id === rule.id).reduce((sum, d) => sum + d.commission_cents, 0);
            commission = Math.max(0, Math.min(commission, rule.cap_per_customer_cents - (earned?.cents || 0) - alreadyInOrder));
        }
        detail.push({ rule_id: rule?.id || null, product_id: line.product_id || null, base_cents: line.amount_cents, commission_cents: commission });
    }
    const commission = detail.reduce((sum, d) => sum + d.commission_cents, 0);
    const single = new Set(detail.map(d => d.rule_id));
    const onlyRule = single.size === 1 ? rules.find(r => r.id === [...single][0]) : null;
    const pct = single.size === 1 && [...single][0] === null ? affiliate.commission_pct
        : onlyRule?.kind === 'percent' ? onlyRule.percent : null;
    return { commission, pct, detail };
}
