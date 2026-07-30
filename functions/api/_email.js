// Shared Brevo email helpers. Update the sender name/email to match your
// store or configure ADMIN_EMAIL in your env vars for admin notifications.

const SENDER = { name: 'Store', email: 'hello@example.com' };

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
        to: [{ email: env.ADMIN_EMAIL || 'admin@example.com' }],
        subject,
        htmlContent: body,
    });
}
