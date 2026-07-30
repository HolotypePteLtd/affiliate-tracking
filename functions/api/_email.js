// Shared Brevo email helpers. Previously duplicated (with identical bodies) in
// free-checkout.js and stripe-webhook.js; extracted so the affiliate handlers
// reuse the same path. Sender identity is fixed for transactional mail.

const SENDER = { name: 'Holotype', email: 'hello@holotype.com.sg' };

// Escape user/Stripe-provided strings before interpolating into HTML email
// bodies, so a malicious email or product name can't inject markup.
export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// Send a transactional email via Brevo. Returns the fetch Response (caller
// checks .ok). BREVO_API_KEY is required; the deploy gate (stripe-health)
// blocks deploys without it.
export async function sendEmail(apiKey, params) {
    return fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({ ...params, sender: params.sender || SENDER }),
    });
}

// Best-effort admin notification that must NOT gate the main request path.
// No-op if BREVO_API_KEY is unset.
export async function notifyAdmin(env, { subject, body }) {
    const brevoKey = env.BREVO_API_KEY;
    if (!brevoKey) return;
    await sendEmail(brevoKey, {
        to: [{ email: env.ADMIN_EMAIL || 'nick@holotype.com.sg' }],
        subject,
        htmlContent: body,
    });
}
