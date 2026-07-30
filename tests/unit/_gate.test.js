import { describe, it, expect, beforeEach } from 'vitest';
import { requireAdmin } from '../../functions/api/admin/_gate.js';

function mockRequest(token) {
    return {
        headers: {
            get(name) {
                if (name === 'x-admin-token') return token || null;
                return null;
            },
        },
    };
}

describe('requireAdmin', () => {
    it('returns null when ADMIN_TOKEN is not configured', () => {
        const env = {};
        expect(requireAdmin(env, mockRequest('anything'))).toBeNull();
    });

    it('returns null when the correct token is provided', () => {
        const env = { ADMIN_TOKEN: 'my-secret-token' };
        expect(requireAdmin(env, mockRequest('my-secret-token'))).toBeNull();
    });

    it('returns a 401 response when the wrong token is provided', () => {
        const env = { ADMIN_TOKEN: 'real-token' };
        const resp = requireAdmin(env, mockRequest('wrong-token'));
        expect(resp).toBeInstanceOf(Response);
        expect(resp.status).toBe(401);
    });

    it('returns 401 when no token is provided but one is configured', () => {
        const env = { ADMIN_TOKEN: 'real-token' };
        const resp = requireAdmin(env, mockRequest(null));
        expect(resp).toBeInstanceOf(Response);
        expect(resp.status).toBe(401);
    });

    it('returns null with empty env but valid ADMIN_TOKEN unset', () => {
        const env = { ADMIN_TOKEN: undefined };
        expect(requireAdmin(env, mockRequest(''))).toBeNull();
    });
});
