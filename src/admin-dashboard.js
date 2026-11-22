// Dependency-free admin UI. Served by the affiliate router, so consumers don't
// need a particular site generator or frontend framework.
import { escapeHtml } from '../functions/api/_email.js';

const html = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style nonce="__NONCE__">
:root{color-scheme:dark;--bg:#111512;--panel:#19201b;--line:#303a32;--text:#edf3ed;--muted:#a4b2a7;--accent:#b6f280}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}a{color:var(--accent)}button,input,select{font:inherit}button{cursor:pointer}button,input,select{border:1px solid var(--line);border-radius:8px;padding:10px 14px;background:var(--panel);color:var(--text)}button:hover{border-color:var(--accent)}button:disabled{opacity:.5;cursor:wait}button.primary{background:var(--accent);color:#14200d;border-color:var(--accent);font-weight:650}button.small{padding:5px 10px;font-size:13px}input,select{width:100%}input:focus,button:focus-visible,select:focus{outline:2px solid var(--accent);outline-offset:3px}[hidden]{display:none!important}
header{border-bottom:1px solid var(--line)}header>div,main{max-width:1280px;margin:auto;padding:24px 32px}.row{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.spread{justify-content:space-between}.brand{font-weight:650;letter-spacing:.08em;font-size:13px;text-transform:uppercase}.eyebrow{color:var(--accent);font-size:12px;letter-spacing:.13em;text-transform:uppercase}h1{font-size:clamp(28px,4vw,40px);line-height:1.15;margin:8px 0 12px;letter-spacing:-.04em}h2{font-size:19px;margin:0}p{margin:0 0 16px}.muted{color:var(--muted)}.intro{padding:20px 0 28px}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}.login{max-width:440px;margin:50px auto}.login label{display:block;margin:22px 0 8px}.login button{margin-top:18px}.notice{padding:14px 18px;border:1px solid #586e38;background:#202b19;border-radius:10px;margin:0 0 24px}.error{color:#ffb4a7}.feedback{min-height:24px;margin:12px 0}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:28px}.stat{font-size:30px;letter-spacing:-.04em;margin-top:8px}.tabs{display:flex;gap:8px;border-bottom:1px solid var(--line);margin-bottom:24px;padding-bottom:14px}.tabs button{border-color:transparent;background:transparent;color:var(--muted)}.tabs button[aria-selected=true]{color:var(--accent);background:var(--panel);border-color:var(--line)}.toolbar{margin-bottom:18px}.toolbar select,.toolbar input{width:auto;max-width:300px}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:16px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}td small{display:block;color:var(--muted);max-width:320px;overflow-wrap:anywhere}.badge{display:inline-block;padding:3px 8px;border-radius:5px;background:#27332a;font-size:12px;white-space:nowrap}.badge.pending{color:#f5d98a}.badge.active,.badge.approved,.badge.paid,.badge.sent{color:var(--accent)}.badge.failed,.badge.suspended{color:#ffb4a7}.empty{padding:32px;text-align:center;color:var(--muted)}.create{margin-bottom:24px}.fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:20px 0}.fields label{font-size:13px;color:var(--muted)}.fields input{margin-top:6px}.actions{display:flex;gap:8px;align-items:center}.note{font-size:13px;color:var(--muted);margin-top:18px}footer{color:var(--muted);font-size:12px;padding:30px 0}
@media(max-width:700px){header>div,main{padding:20px 16px}.stats,.fields{grid-template-columns:repeat(2,minmax(0,1fr))}.card{padding:18px}.toolbar select,.toolbar input{max-width:100%;width:100%}.stat{font-size:24px}.login{margin:24px auto}.tabs{overflow:auto}}
</style>
__STYLESHEETS__
</head>
<body class="affiliate-admin">
<header><div class="row spread">__BRAND__<div class="row"><a href="/">Storefront</a><a href="/affiliates/">Affiliate portal</a><button id="sign-out" hidden>Sign out</button></div></div></header>
<main>
<section id="login" class="card login">
  <span class="eyebrow">Program management</span><h1>Welcome back.</h1><p class="muted">Sign in to review partners, commissions, and payouts.</p>
  <form id="login-form"><label for="admin-token">Admin token</label><input id="admin-token" type="password" required autocomplete="off"><button class="primary" type="submit">Sign in</button></form>
  <div id="local-login" hidden><p class="note">Local demo is available. No token needed.</p><button id="demo-admin">Sign in as demo admin</button><button id="demo-affiliate">Try the affiliate dashboard</button></div>
  <p id="login-error" class="feedback error" role="alert"></p>
</section>
<section id="dashboard" hidden>
  <div class="intro row spread"><div><span class="eyebrow">Partner operations</span><h1>Affiliate overview</h1><p class="muted">Review applications, approve commissions, and track payouts.</p></div><button id="refresh">Refresh</button></div>
  <div id="demo-notice" class="notice" hidden>Local demo data. Demo partner approvals skip email and Stripe. Payments are disabled. <a href="/affiliates/">Try the affiliate dashboard →</a></div>
  <div class="stats"><div class="card"><span class="muted">Active partners</span><div class="stat" id="active-count">—</div></div><div class="card"><span class="muted">Pending partners</span><div class="stat" id="pending-count">—</div></div><div class="card"><span class="muted">Recent pending commission</span><div class="stat" id="pending-total">—</div></div><div class="card"><span class="muted">Recent approved commission</span><div class="stat" id="approved-total">—</div></div></div>
  <nav class="tabs" aria-label="Admin sections"><button data-tab="affiliates" aria-selected="true">Partners</button><button data-tab="conversions" aria-selected="false">Conversions</button><button data-tab="payouts" aria-selected="false">Payouts</button></nav>
  <p id="feedback" class="feedback" role="status" aria-live="polite"></p>
  <section id="affiliates-panel">
    <div class="toolbar row spread"><h2>Partners</h2><div class="row"><label for="partner-filter" class="muted">Status</label><select id="partner-filter"><option value="">All partners</option><option value="pending">Pending</option><option value="active">Active</option><option value="suspended">Suspended</option></select><button id="show-create">Add partner</button></div></div>
    <form id="create-form" class="card create" hidden><h2>Add a partner</h2><div class="fields"><label>Email<input name="email" type="email" required></label><label>Name<input name="name"></label><label>Referral code<input name="code" pattern="[a-zA-Z0-9_-]{2,}" required></label><label>Commission %<input name="commissionPct" type="number" min="1" max="100" value="20" required></label></div><button class="primary" type="submit">Create partner</button><p class="note">New partners start pending. Approval activates their referral code.</p></form>
    <div class="card scroll"><table><thead><tr><th scope="col">Partner</th><th scope="col">Status</th><th scope="col">Referral code</th><th scope="col">Commission</th><th scope="col">Clicks</th><th scope="col">Application</th><th scope="col">Action</th></tr></thead><tbody id="affiliate-rows"></tbody></table><p id="affiliates-empty" class="empty" hidden>No partners match this filter.</p></div>
  </section>
  <section id="conversions-panel" hidden>
    <div class="toolbar row spread"><h2>Recent conversions</h2><div class="row"><label for="conversion-filter" class="muted">Status</label><select id="conversion-filter"><option value="">All conversions</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="paying">Paying</option><option value="paid">Paid</option><option value="refunded">Refunded</option></select></div></div>
    <div class="card scroll"><table><thead><tr><th scope="col">Date</th><th scope="col">Partner</th><th scope="col">Customer</th><th scope="col">Sale</th><th scope="col">Commission</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody id="conversion-rows"></tbody></table><p id="conversions-empty" class="empty" hidden>No conversions match this filter.</p></div><p class="note">Showing the latest 200 conversions. Commission totals above cover these records.</p>
  </section>
  <section id="payouts-panel" hidden>
    <div class="toolbar row spread"><h2>Recent payouts</h2><button id="run-payouts" class="primary">Run approved payouts</button></div>
    <p class="muted">Connect partners receive Stripe transfers. For manual partners, send payment separately before recording the payout.</p>
    <div class="card scroll"><table><thead><tr><th scope="col">Date</th><th scope="col">Partner</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Stripe transfer</th><th scope="col">Actions</th></tr></thead><tbody id="payout-rows"></tbody></table><p id="payouts-empty" class="empty" hidden>No payouts yet.</p></div><p class="note">Showing the latest 200 payouts.</p>
  </section>
</section>
<footer>Affiliate program administration</footer>
</main>
<script nonce="__NONCE__">
(() => {
  const $ = id => document.getElementById(id);
  const ZERO_DECIMAL = new Set(['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','vnd','vuv','xaf','xof','xpf']);
  const money = (minor, cur) => {
    const code = typeof cur === 'string' && /^[a-z]{3}$/i.test(cur) ? cur.toLowerCase() : 'usd';
    const decimals = (code === 'isk' || code === 'ugx') ? 2 : ZERO_DECIMAL.has(code) ? 0
      : new Intl.NumberFormat('en-US', { style: 'currency', currency: code.toUpperCase() }).resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code.toUpperCase() }).format((minor || 0) / (10 ** decimals));
  };
  const sumByCurrency = rows => {
    if (!rows.length) return money(0, 'usd');
    const totals = new Map();
    for (const r of rows) {
      const code = (typeof r.currency === 'string' && /^[a-z]{3}$/i.test(r.currency)) ? r.currency.toLowerCase() : 'usd';
      totals.set(code, (totals.get(code) || 0) + (r.commission_cents || 0));
    }
    return [...totals.entries()].map(([code, total]) => money(total, code)).join(' + ');
  };
  const date = value => new Date(value).toLocaleDateString();
  let state = { affiliates: [], conversions: [], payouts: [] };
  let localDemo = false;
  let busy = false;
  async function api(path, body) {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const payoutErrors = (data.payouts || []).map(p => p.error).filter(Boolean).join(' ');
      const error = new Error(data.error || payoutErrors || 'Request failed (HTTP ' + res.status + ').');
      error.status = res.status; throw error;
    }
    return data;
  }
  function feedback(message, error = false) { $('feedback').textContent = message; $('feedback').classList.toggle('error', error); }
  function signedOut() { $('login').hidden = false; $('dashboard').hidden = true; $('sign-out').hidden = true; state = { affiliates: [], conversions: [], payouts: [] }; ['affiliate-rows', 'conversion-rows', 'payout-rows'].forEach(id => $(id).replaceChildren()); }
  function cell(row, text, detail) {
    const td = document.createElement('td'); td.textContent = text == null ? '—' : String(text);
    if (detail) { const small = document.createElement('small'); small.textContent = detail; td.appendChild(small); }
    row.appendChild(td); return td;
  }
  function badge(row, status) {
    const td = cell(row, ''); const span = document.createElement('span'); span.textContent = status;
    span.className = 'badge ' + (['pending','active','suspended','approved','paying','paid','refunded','sent','failed','manual'].includes(status) ? status : ''); td.appendChild(span);
  }
  function action(container, label, handler) {
    const button = document.createElement('button'); button.className = 'small'; button.textContent = label;
    button.disabled = busy; button.addEventListener('click', () => mutate(handler)); container.appendChild(button);
  }
  function render() {
    $('active-count').textContent = state.affiliates.filter(a => a.status === 'active').length;
    $('pending-count').textContent = state.affiliates.filter(a => a.status === 'pending').length;
    ['pending','approved'].forEach(status => $(status + '-total').textContent = sumByCurrency(state.conversions.filter(c => c.status === status)));
    const partners = state.affiliates.filter(a => !$('partner-filter').value || a.status === $('partner-filter').value);
    $('affiliate-rows').replaceChildren(); $('affiliates-empty').hidden = partners.length > 0;
    partners.forEach(a => {
      const row = document.createElement('tr'); cell(row, a.name || a.email, a.email); badge(row, a.status); cell(row, a.code); cell(row, a.commission_pct + '%', a.review_required ? 'Every sale reviewed by hand' : ''); cell(row, a.clicks); cell(row, a.message || '—', a.source === 'application' ? 'Self-serve application' : a.source === 'local-demo' ? 'Local demo' : 'Added by admin');
      const actions = document.createElement('div'); actions.className = 'actions'; cell(row, '').appendChild(actions);
      if (a.status === 'pending') {
        action(actions, 'Approve partner', async () => {
          if (!localDemo && !window.confirm('Activate ' + a.email + '? This creates their Stripe promotion code and sends an acceptance email.')) return null;
          await api('/api/admin/affiliate-approve', { id: a.id }); return 'Partner approved.';
        });
      } else {
        const status = a.status_change_target || (a.status === 'active' ? 'suspended' : 'active');
        const label = status === 'suspended' ? 'Suspend' : 'Reactivate';
        action(actions, label, async () => {
          if (!window.confirm(label + ' ' + a.email + '?')) return null;
          await api('/api/admin/affiliate-status', { id: a.id, status });
          return status === 'suspended' ? 'Partner suspended.' : 'Partner reactivated.';
        });
        action(actions, a.review_required ? 'Stop manual review' : 'Always review sales', async () => {
          await api('/api/admin/affiliate-review', { id: a.id, review_required: !a.review_required });
          return a.review_required ? 'Sales from ' + a.email + ' follow the hold period again.' : 'Every sale from ' + a.email + ' now waits for manual approval.';
        });
        if (a.status === 'active') action(actions, 'Revoke sessions', async () => {
          if (!window.confirm('Sign out ' + a.email + ' on all devices and invalidate their existing login links?')) return null;
          await api('/api/admin/affiliate-revoke-sessions', { id: a.id });
          return 'Partner sessions revoked.';
        });
      }
      $('affiliate-rows').appendChild(row);
    });
    const conversions = state.conversions.filter(c => !$('conversion-filter').value || c.status === $('conversion-filter').value);
    $('conversion-rows').replaceChildren(); $('conversions-empty').hidden = conversions.length > 0;
    conversions.forEach(c => {
      const row = document.createElement('tr'); cell(row, date(c.created_at)); cell(row, c.affiliate_name || c.affiliate_code); cell(row, c.customer_email); cell(row, money(c.amount_cents, c.currency)); cell(row, money(c.commission_cents, c.currency)); badge(row, c.status); if (c.fraud_reason) { const flag = document.createElement('small'); flag.className = 'error'; flag.textContent = c.fraud_reason === 'self_email' ? 'Flagged: buyer email is the partner\'s' : c.fraud_reason === 'self_ip' ? 'Flagged: bought from the partner\'s sign-in IP' : 'Flagged: ' + c.fraud_reason; row.lastChild.appendChild(flag); }
      if (c.status === 'pending' || c.status === 'approved') action(cell(row, ''), c.status === 'pending' ? 'Approve' : 'Return to pending', async () => {
        await api('/api/admin/conversion-approve', { id: c.id, approved: c.status === 'pending' }); return 'Conversion updated.';
      }); else cell(row, '—');
      $('conversion-rows').appendChild(row);
    });
    $('payout-rows').replaceChildren(); $('payouts-empty').hidden = state.payouts.length > 0;
    state.payouts.forEach(p => {
      const row = document.createElement('tr');
      cell(row, date(p.created_at)); cell(row, p.affiliate_name || p.affiliate_code); cell(row, money(p.amount_cents, p.currency));
      badge(row, p.status); cell(row, p.stripe_transfer_id);
      if (p.status === 'pending' && !localDemo) action(cell(row, ''), 'Reconcile payout', async () => {
        const data = await api('/api/admin/payouts-reconcile', { id: p.id });
        if (data.status === 'sent') return 'Verified and recorded Stripe transfer ' + data.stripe_transfer_id + '.';
        if (data.status !== 'pending') return 'Payout is already ' + data.status + '.';
        if (!data.can_release) return 'Stripe shows no matching transfer yet. Check again after the 24-hour waiting period.';
        if (!window.confirm('Stripe shows no matching transfer. Confirm that no payment was made outside Stripe and return this batch’s unpaid commissions to approved?')) return null;
        const result = await api('/api/admin/payouts-reconcile', { id: p.id, action: 'release' });
        return result.status === 'failed' ? 'Batch released. Run payouts again for eligible commissions.' : 'Payout is now ' + result.status + '.';
      }); else cell(row, '—');
      $('payout-rows').appendChild(row);
    });
    $('run-payouts').disabled = busy || localDemo || !(state.conversions.some(c => c.status === 'approved') || state.payouts.some(p => p.status === 'pending'));
    $('run-payouts').title = localDemo ? 'Payments are disabled in local demo mode.' : '';
  }
  async function load() {
    const [partners, conversions, payouts] = await Promise.all([api('/api/admin/affiliates'), api('/api/admin/conversions'), api('/api/admin/payouts')]);
    state = { affiliates: partners.affiliates, conversions: conversions.conversions, payouts: payouts.payouts };
    $('login').hidden = true; $('dashboard').hidden = false; $('sign-out').hidden = false; render();
  }
  async function mutate(handler) {
    if (busy) return;
    busy = true; render();
    const formButtons = [$('create-form').querySelector('button'), $('refresh'), $('show-create')];
    formButtons.forEach(button => button.disabled = true);
    try { const message = await handler(); if (message) { await load(); feedback(message); } }
    catch (error) { if (error.status === 401) signedOut(); feedback(error.message, true); }
    finally { busy = false; formButtons.forEach(button => button.disabled = false); render(); }
  }
  async function signIn(path, body) {
    $('login-error').textContent = '';
    const buttons = $('login').querySelectorAll('button'); buttons.forEach(button => button.disabled = true);
    try { await api(path, body); $('admin-token').value = ''; await load(); }
    catch (error) { $('login-error').textContent = error.message; }
    finally { buttons.forEach(button => button.disabled = false); }
  }
  $('login-form').addEventListener('submit', event => { event.preventDefault(); signIn('/api/admin/login', { token: $('admin-token').value }); });
  $('demo-admin').addEventListener('click', () => signIn('/api/admin/dev-login', {}));
  $('demo-affiliate').addEventListener('click', async () => { try { await api('/api/affiliate/dev-login', {}); window.location.href = '/affiliates/dashboard/'; } catch (error) { $('login-error').textContent = error.message; } });
  $('sign-out').addEventListener('click', async () => { try { await api('/api/admin/logout', {}); signedOut(); } catch (error) { feedback(error.message, true); } });
  $('refresh').addEventListener('click', () => mutate(async () => 'Data refreshed.'));
  $('partner-filter').addEventListener('change', render); $('conversion-filter').addEventListener('change', render);
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(tab => { const selected = tab === button; tab.setAttribute('aria-selected', String(selected)); $(tab.dataset.tab + '-panel').hidden = !selected; }); feedback('');
  }));
  $('show-create').addEventListener('click', () => { $('create-form').hidden = !$('create-form').hidden; if (!$('create-form').hidden) $('create-form').elements.email.focus(); });
  $('create-form').addEventListener('submit', event => { event.preventDefault(); mutate(async () => {
    const form = new FormData(event.currentTarget); await api('/api/admin/affiliates', { email: form.get('email'), name: form.get('name'), code: form.get('code'), commissionPct: Number(form.get('commissionPct')) });
    $('create-form').reset(); $('create-form').hidden = true; return 'Partner created. Approve them to activate their referral code.';
  }); });
  $('run-payouts').addEventListener('click', () => mutate(async () => {
    if (!window.confirm('Run payouts for approved commissions? Connect transfers will be sent now. For manual partners, confirm you have already sent their payment separately.')) return null;
    const data = await api('/api/admin/payouts-run', {});
    const pending = (data.payouts || []).filter(p => p.status === 'pending');
    if (pending.length) throw new Error(pending.map(p => p.error || 'A payout needs reconciliation.').join(' '));
    return 'Payouts recorded.';
  }));
  async function start() {
    try { const dev = await api('/api/affiliate/dev'); localDemo = dev.enabled === true; } catch {}
    $('local-login').hidden = !localDemo; $('demo-notice').hidden = !localDemo;
    try { await load(); } catch (error) { signedOut(); if (error.status !== 401) $('login-error').textContent = error.message; }
  }
  start();
})();
</script>
</body></html>`;

// Hosts can supply branding and styles without copying the admin UI or its
// session logic. Asset URLs and font origins come from trusted host config.
export function adminDashboard(context = {}, appearance = {}) {
    const nonce = crypto.randomUUID();
    const brandName = appearance.brandName || 'Affiliate program / Admin';
    const brand = appearance.logoUrl
        ? `<a class="brand" href="/" aria-label="${escapeHtml(brandName)} home"><img src="${escapeHtml(appearance.logoUrl)}" alt="${escapeHtml(brandName)}" width="371" height="81"></a>`
        : `<span class="brand">${escapeHtml(brandName)}</span>`;
    const stylesheets = appearance.stylesheets || [];
    const requestOrigin = new URL(context.request?.url || 'https://affiliate.example').origin;
    const httpOrigin = (url, base) => {
        try {
            const parsed = base ? new URL(url, base) : new URL(url);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
        } catch { return null; }
    };
    const styleOrigins = [...new Set(stylesheets.map(url => httpOrigin(url, requestOrigin)).filter(Boolean))]
        .filter(origin => origin !== requestOrigin);
    const fontOrigins = [...new Set((appearance.fontOrigins || []).map(url => httpOrigin(url)).filter(Boolean))];
    const page = html.replaceAll('__NONCE__', nonce)
        .replace('__TITLE__', () => escapeHtml(appearance.title || 'Affiliate admin'))
        .replace('__BRAND__', () => brand)
        .replace('__STYLESHEETS__', () => stylesheets.map(url => `<link rel="stylesheet" href="${escapeHtml(url)}">`).join('\n'));
    return new Response(page, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}' ${styleOrigins.join(' ')}; img-src 'self'; font-src 'self' ${fontOrigins.join(' ')}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    } });
}
