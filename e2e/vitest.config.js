// End-to-end tests against Stripe's real test mode. Not part of `pnpm test`.
// Run: STRIPE_TEST_SECRET_KEY=sk_test_… pnpm test:e2e
// They create test-mode objects (a test clock, customer, product, payments)
// and clean them up. Stripe test clocks take a few seconds per step, so the
// tests have no time limit.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        root: new URL('..', import.meta.url).pathname,
        include: ['e2e/**/*.e2e.js'],
        testTimeout: 0,
        hookTimeout: 0,
    },
});
