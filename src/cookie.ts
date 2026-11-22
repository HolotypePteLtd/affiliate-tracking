export function hostCookieName(name: string, requestUrl: string) {
    if (name.startsWith('__Host-')) {
        const url = new URL(requestUrl);
        if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
            return name.slice('__Host-'.length);
        }
    }
    return name;
}

export function authCookieHeader(name: string, token: string, requestUrl: string, maxAge: number, sameSite: string) {
    const cookie = hostCookieName(name, requestUrl);
    const secure = cookie.startsWith('__Host-') ? '; Secure' : '';
    return `${cookie}=${token}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}; Path=/${secure}`;
}
