// Stripe charge amounts use minor units. ISK and UGX retain two decimal
// API representations even though their currencies have no fractional coins.
// https://docs.stripe.com/currencies
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

export function currencyCode(value: unknown): string | null {
    return typeof value === 'string' && /^[a-z]{3}$/i.test(value) ? value.toLowerCase() : null;
}

export function currencyDecimals(value: unknown): number | null {
    const code = currencyCode(value);
    if (!code) return null;
    if (code === 'isk' || code === 'ugx') return 2;
    if (ZERO_DECIMAL.has(code)) return 0;
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? null;
}
