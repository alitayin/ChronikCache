const assert = require('node:assert/strict');
const FailoverHandler = require('../../src/lib/failover').default;

describe('FailoverHandler', () => {
    it('retries until the operation succeeds', async () => {
        const handler = new FailoverHandler({
            maxRetries: 3,
            retryDelay: 1,
        });

        let attempts = 0;
        const result = await handler.executeWithRetry(async () => {
            attempts += 1;
            if (attempts < 3) {
                throw new Error('temporary');
            }
            return 'ok';
        }, 'retry-test');

        assert.equal(result, 'ok');
        assert.equal(attempts, 3);
    });

    it('throws after all retries are exhausted', async () => {
        const handler = new FailoverHandler({
            maxRetries: 2,
            retryDelay: 1,
        });

        await assert.rejects(
            handler.executeWithRetry(async () => {
                throw new Error('always fails');
            }, 'exhaust-test'),
            /always fails/,
        );
    });

    it('returns null for NotFoundError in handleDbOperation', async () => {
        const handler = new FailoverHandler({
            maxRetries: 1,
            retryDelay: 1,
        });

        const result = await handler.handleDbOperation(async () => {
            const error = new Error('missing');
            error.type = 'NotFoundError';
            throw error;
        }, 'db-not-found');

        assert.equal(result, null);
    });

    it('respects exponentialBackoff: false', async () => {
        const originalSetTimeout = global.setTimeout;
        const delays = [];
        global.setTimeout = ((fn, ms, ...args) => {
            delays.push(ms);
            return originalSetTimeout(fn, 0, ...args);
        });

        try {
            const handler = new FailoverHandler({
                maxRetries: 3,
                retryDelay: 5,
                exponentialBackoff: false,
            });

            let attempts = 0;
            await handler.executeWithRetry(async () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new Error('retry');
                }
                return 'ok';
            }, 'no-backoff');

            assert.deepStrictEqual(delays, [5, 5]);
        } finally {
            global.setTimeout = originalSetTimeout;
        }
    });
});
