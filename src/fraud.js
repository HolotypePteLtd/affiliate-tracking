// Fraud checks.
//
// Clicks: link-preview fetchers and crawlers are not counted, and one IP
// counts at most once per affiliate per CLICK_WINDOW_MS, so a script hitting
// a referral link repeatedly can't inflate the numbers.
//
// Conversions: a sale is flagged (conversions.fraud_reason) when it looks like
// the affiliate bought through their own referral. Flagged sales stay pending
// for an admin; the hold period never approves them.

export const CLICK_WINDOW_MS = 24 * 60 * 60 * 1000;

// Link previews (chat apps, social sites) and crawlers fetch a URL without a
// person clicking it.
const BOT_USER_AGENT = /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|facebookcatalog|embedly|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot|skypeuripreview|pinterest|redditbot|applebot|bingpreview|googleother|vkshare|w3c_validator|headlesschrome|lighthouse|curl\/|wget\/|python-requests|go-http-client|node-fetch|axios\//i;

export function isAutomatedRequest(request) {
    const cf = request.cf;
    if (cf?.botManagement?.verifiedBot) return true;
    return BOT_USER_AGENT.test(request.headers.get('user-agent') || '');
}

export function selfReferralReason({ affiliateEmail, customerEmail, buyerIpHash, affiliateIpHashes }) {
    const normalize = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');
    if (normalize(customerEmail) && normalize(customerEmail) === normalize(affiliateEmail)) return 'self_email';
    if (buyerIpHash && affiliateIpHashes.includes(buyerIpHash)) return 'self_ip';
    return null;
}
