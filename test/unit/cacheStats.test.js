const assert = require('node:assert/strict');
const CacheStats = require('../../src/lib/CacheStats').default;

describe('CacheStats', () => {
    it('returns the expected statistics structure', async () => {
        const cache = {
            db: {
                calculateCacheSize: async () => 1024,
                db: {
                    async *iterator() {
                        yield ['ecash:test:txOrder', ['a']];
                        yield ['metadata:address:ecash:test', { accessCount: 1 }];
                    },
                },
            },
            getCacheStatus: () => 'LATEST',
            _getGlobalMetadata: async () => ({
                createdAt: 1,
                lastAccessAt: 2,
                accessCount: 3,
                numTxs: 4,
            }),
            globalMetadataCache: new Map(),
            globalMetadataCacheLimit: 100,
            wsManager: {
                wsSubscriptions: new Map(),
            },
            updateQueue: {
                getQueueLength: () => 0,
                maxConcurrency: 2,
            },
            txUpdateQueue: {
                getQueueLength: () => 0,
                maxConcurrency: 5,
            },
            maxTxLimit: 10000,
            maxCacheSize: 1024 * 1024,
            defaultPageSize: 200,
            cacheDir: './.cache',
        };
        const logger = {
            error: () => {},
        };

        const stats = await new CacheStats(cache, logger).getStatistics();

        assert.equal(stats.items.total, 1);
        assert.equal(stats.items.byStatus.LATEST, 1);
        assert.equal(stats.system.globalMetadataCache.limit, 100);
        assert.equal(stats.database.totalSize, '0.00MB');
        assert.equal(stats.queues.updateQueue.maxConcurrency, 2);
    });

    it('falls back to Unknown db size when db stats fail', async () => {
        const cache = {
            db: {
                calculateCacheSize: async () => {
                    throw new Error('db failed');
                },
                db: {
                    async *iterator() {},
                },
            },
            getCacheStatus: () => 'UNKNOWN',
            _getGlobalMetadata: async () => null,
            globalMetadataCache: new Map(),
            globalMetadataCacheLimit: 10,
            wsManager: {
                wsSubscriptions: new Map(),
            },
            updateQueue: {
                getQueueLength: () => 0,
                maxConcurrency: 2,
            },
            txUpdateQueue: {
                getQueueLength: () => 0,
                maxConcurrency: 5,
            },
            maxTxLimit: 10000,
            maxCacheSize: 1024,
            defaultPageSize: 200,
            cacheDir: './.cache',
        };
        const logger = {
            error: () => {},
        };

        const stats = await new CacheStats(cache, logger).getStatistics();

        assert.equal(stats.database.totalSize, 'Unknown');
    });
});
