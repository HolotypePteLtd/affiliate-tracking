// Transactional email integration point.
//
// Defaults to Brevo (Sendinblue) but is configurable for any JSON-based
// email API via env vars — see setup instructions in the README.
//
// To switch providers, either:
//   a) Set EMAIL_URL + EMAIL_AUTH_HEADER env vars (no code changes), or
//   b) Rewrite sendEmail() below (it's ~10 lines).
//
// Sender identity comes from env vars with neutral fallbacks, so a consumer
// never ships this library's domains in their mail:
//   EMAIL_SENDER_NAME     — display name (default "Store")
//   EMAIL_SENDER_ADDRESS  — from-address  (default hello@example.com)

// Escape user/Stripe-provided strings before interpolating into HTML email
// bodies, so a malicious email or product name can't inject markup.
export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// The From identity for all library-sent mail.
export function emailSender(env = {}) {
    return {
        name: env.EMAIL_SENDER_NAME || 'Store',
        email: env.EMAIL_SENDER_ADDRESS || 'hello@example.com',
    };
}

// The admin recipient for notifications (best-effort set-and-forget).
export function adminEmail(env = {}) {
    return env.ADMIN_EMAIL || 'admin@example.com';
}

// Send a transactional email. Returns the fetch Response (caller checks .ok).
//
// Default: Brevo/Sendinblue via the api-key header.
// Override via env vars:
//   EMAIL_URL          — API endpoint (default https://api.brevo.com/v3/smtp/email)
//   EMAIL_AUTH_HEADER  — header name for the API key (default 'api-key')
//   BREVO_API_KEY      — the API key value (env var name kept for brevity)
//
// The `params` object should match your provider's request body schema.
// Callers currently pass { to, subject, htmlContent } — swap htmlContent
// for your provider's body field if different.
export async function sendEmail(apiKey, params, env = {}) {
    const url = env.EMAIL_URL || 'https://api.brevo.com/v3/smtp/email';
    const authHeader = env.EMAIL_AUTH_HEADER || 'api-key';
    return fetch(url, {
        method: 'POST',
        headers: {
            [authHeader]: apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({ ...params, sender: params.sender || emailSender(env) }),
    });
}

// Best-effort admin notification that must NOT gate the main request path.
// No-op if the configured API key is unset.
export async function notifyAdmin(env, { subject, body }) {
    const apiKey = env.BREVO_API_KEY;
    if (!apiKey) return;
    try {
        const response = await sendEmail(apiKey, {
            to: [{ email: adminEmail(env) }],
            subject,
            htmlContent: body,
        }, env);
        if (!response.ok) console.error('Admin notification failed:', response.status);
    } catch (err) {
        console.error('Admin notification failed:', err.message);
    }
}
