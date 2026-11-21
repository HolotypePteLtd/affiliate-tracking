import { signedInAffiliate } from './_dashboard.js';
import { createOnboardingLink } from '../../../src/stripe.js';
import { isLocalAffiliateDev } from '../../../src/dev.js';

export async function onRequestGet({ request, env }) {
    const affiliate = await signedInAffiliate(request, env);
    if (affiliate instanceof Response) {
        if (affiliate.status === 401) return Response.redirect(new URL('/affiliates/', request.url), 302);
        return affiliate;
    }
    if (isLocalAffiliateDev(request, env) || !affiliate.stripe_account_id) {
        return Response.json({ ok: false, error: 'Stripe Connect onboarding is unavailable for this affiliate' }, { status: 409 });
    }
    try {
        const url = await createOnboardingLink(request, env, affiliate.stripe_account_id);
        return new Response(null, { status: 303, headers: {
            Location: url,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
        } });
    } catch (error) {
        console.error('Stripe Connect onboarding link failed:', error.message);
        return Response.json({ ok: false, error: 'Could not create a Stripe onboarding link. Please try again.' }, { status: 502 });
    }
}
