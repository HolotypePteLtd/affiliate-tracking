//   GET  /api/admin/commission-rules                    every rule, newest first
//   POST /api/admin/commission-rules { kind, percent | fixed_cents+currency,
//        affiliate_id?, product_id?, min_monthly_sales?, cap_per_customer_cents? }
//   POST /api/admin/commission-rule-archive { id }     stop using a rule (history keeps it)

import { requireAdmin } from './_gate.js';
import { readJsonObject } from '../_public.js';
import { currencyCode } from '../../../src/money.js';

const bad = error => Response.json({ ok: false, error }, { status: 400 });
const optionalInteger = (value, min) => value === undefined || value === null || (Number.isSafeInteger(value) && value >= min);

export async function onRequestGet({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const { results } = await env.DB.prepare('SELECT * FROM commission_rules ORDER BY active DESC, created_at DESC').all();
    return Response.json({ ok: true, rules: results || [] });
}

export async function onRequestPost({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const body = await readJsonObject(request);
    const { kind } = body;
    if (kind === 'percent') {
        if (typeof body.percent !== 'number' || !(body.percent >= 0 && body.percent <= 100)) return bad('percent must be a number from 0 to 100');
    } else if (kind === 'fixed') {
        if (!Number.isSafeInteger(body.fixed_cents) || body.fixed_cents < 0) return bad('fixed_cents must be a whole number of minor units');
        if (!currencyCode(body.currency)) return bad('A fixed rule needs a three-letter currency');
    } else {
        return bad('kind must be percent or fixed');
    }
    if (!optionalInteger(body.affiliate_id, 1)) return bad('affiliate_id must be an affiliate id');
    if (body.product_id !== undefined && body.product_id !== null &&
        !(typeof body.product_id === 'string' && /^(prod|price)_[A-Za-z0-9]+$/.test(body.product_id))) {
        return bad('product_id must be a Stripe prod_… or price_… id');
    }
    if (!optionalInteger(body.min_monthly_sales, 0)) return bad('min_monthly_sales must be a whole number');
    if (!optionalInteger(body.cap_per_customer_cents, 0)) return bad('cap_per_customer_cents must be a whole number');
    if (body.affiliate_id && !await env.DB.prepare('SELECT 1 FROM affiliates WHERE id=?1').bind(body.affiliate_id).first()) {
        return Response.json({ ok: false, error: 'Affiliate not found' }, { status: 404 });
    }
    const rule = {
        id: crypto.randomUUID(), affiliate_id: body.affiliate_id ?? null, product_id: body.product_id ?? null, kind,
        percent: kind === 'percent' ? body.percent : null,
        fixed_cents: kind === 'fixed' ? body.fixed_cents : null,
        currency: kind === 'fixed' ? currencyCode(body.currency) : null,
        min_monthly_sales: body.min_monthly_sales ?? 0, cap_per_customer_cents: body.cap_per_customer_cents ?? null,
        active: 1, created_at: Date.now(),
    };
    await env.DB.prepare(`INSERT INTO commission_rules
        (id, affiliate_id, product_id, kind, percent, fixed_cents, currency, min_monthly_sales, cap_per_customer_cents, active, created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`).bind(...Object.values(rule)).run();
    return Response.json({ ok: true, rule }, { status: 201 });
}

export async function onArchivePost({ request, env }) {
    const gate = await requireAdmin(env, request);
    if (gate) return gate;
    if (!env.DB) return Response.json({ ok: false, error: 'DB not bound' }, { status: 500 });
    const { id } = await readJsonObject(request);
    const result = await env.DB.prepare('UPDATE commission_rules SET active=0 WHERE id=?1 AND active=1').bind(String(id ?? '')).run();
    return result.meta?.changes ? Response.json({ ok: true })
        : Response.json({ ok: false, error: 'Active rule not found' }, { status: 404 });
}
