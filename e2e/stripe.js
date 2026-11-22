// A small client for Stripe's test mode, used only by the end-to-end tests.
// Refuses anything but a test key, so it can never touch live data.

export const STRIPE_KEY = process.env.STRIPE_TEST_SECRET_KEY || '';
export const haveStripe = STRIPE_KEY.startsWith('sk_test_') || STRIPE_KEY.startsWith('rk_test_');
if (STRIPE_KEY && !haveStripe) throw new Error('STRIPE_TEST_SECRET_KEY must be a test-mode key (sk_test_…)');

export async function stripe(path, form, method = form ? 'POST' : 'GET') {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
        method,
        headers: { Authorization: `Bearer ${STRIPE_KEY}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Stripe ${method} ${path}: ${data.error?.message || response.status}`);
    return data;
}

// Move a test clock forward and wait until Stripe has finished processing.
export async function advanceClock(clockId, frozenTime) {
    await stripe(`test_helpers/test_clocks/${clockId}/advance`, { frozen_time: String(frozenTime) });
    for (;;) {
        const clock = await stripe(`test_helpers/test_clocks/${clockId}`);
        if (clock.status === 'ready') return clock;
        if (clock.status === 'internal_failure') throw new Error(`Test clock ${clockId} failed to advance`);
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}
