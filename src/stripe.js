export async function stripeRequest(env, path, { form, idempotencyKey } = {}) {
    if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
    const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
        method: form ? 'POST' : 'GET',
        headers,
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
        const error = new Error(data.error?.message || `Stripe request failed (${response.status})`);
        error.code = data.error?.code;
        error.param = data.error?.param;
        throw error;
    }
    return data;
}

export function stripeId(value) {
    const id = typeof value === 'string' ? value : value?.id;
    return typeof id === 'string' && id ? id : null;
}

export async function createOnboardingLink(request, env, account) {
    const origin = new URL(request.url).origin;
    const link = await stripeRequest(env, 'account_links', { form: {
        account,
        refresh_url: `${origin}/api/affiliate/connect-onboarding`,
        return_url: `${origin}/affiliates/dashboard/`,
        type: 'account_onboarding',
    } });
    if (typeof link.url !== 'string' || new URL(link.url).protocol !== 'https:') {
        throw new Error('Stripe returned an invalid onboarding link');
    }
    return link.url;
}
