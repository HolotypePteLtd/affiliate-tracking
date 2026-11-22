import type { AffiliateEnv, JsonObject } from '../../src/types.ts';
// Bound public payloads before parsing and limit both client IP and recipient.
export async function readPublicBody(request: Request) {
    const reader = request.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const body = JSON.parse(new TextDecoder().decode(bytes));
        return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch { return null; }
}

export async function limitPublicRequest(request: Request, env: AffiliateEnv, email = null) {
    if (!env.AFFILIATE_PUBLIC_LIMITER) {
        return Response.json({ success: false, error: 'Affiliate requests are not configured' }, { status: 503 });
    }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    try {
        const ipResult = await env.AFFILIATE_PUBLIC_LIMITER.limit({ key: `affiliate:ip:${ip}` });
        let emailSuccess = true;
        if (email) {
            // Hash the email so rate-limit keys contain no email address.
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
            const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
            const emailResult = await env.AFFILIATE_PUBLIC_LIMITER.limit({ key: `affiliate:email:${hash}` });
            emailSuccess = emailResult.success;
        }
        if (ipResult.success && emailSuccess) return null;
        return Response.json({ success: false, error: 'Too many requests. Please try again shortly.' }, {
            status: 429, headers: { 'Retry-After': '60' },
        });
    } catch {
        return Response.json({ success: false, error: 'Please try again shortly.' }, { status: 503 });
    }
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
    const body: unknown = await request.json().catch(() => null);
    return body && typeof body === 'object' && !Array.isArray(body) ? body as JsonObject : {};
}
