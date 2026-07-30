import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../functions/api/_email.js';

describe('escapeHtml', () => {
    it('escapes &', () => {
        expect(escapeHtml('a&b')).toBe('a&amp;b');
    });

    it('escapes < and >', () => {
        expect(escapeHtml('<tag>')).toBe('&lt;tag&gt;');
    });

    it('escapes double quotes', () => {
        expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
    });

    it('escapes single quotes', () => {
        expect(escapeHtml("it's")).toBe('it&#39;s');
    });

    it('passes through safe strings unchanged', () => {
        expect(escapeHtml('hello world')).toBe('hello world');
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml('123')).toBe('123');
    });

    it('handles null/undefined', () => {
        expect(escapeHtml(null)).toBe('null');
        expect(escapeHtml(undefined)).toBe('undefined');
    });
});
