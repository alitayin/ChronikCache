const assert = require('node:assert/strict');
const { CACHE_STATUS } = require('../../src/constants');
const { encodeCashAddress } = require('ecashaddrjs');
const {
    createTx,
    createHistoryPage,
    createChronikMock,
    createCacheHarness,
} = require('../helpers/mockFactory');

describe('ChronikCache main behaviors', () => {
    const address = 'ecash:qptestaddress';
    const tokenId = 'token-id-1';
    let harness;

    afterEach(async () => {
        if (harness) {
            await harness.cleanup();
            harness = null;
        }
    });

    it('returns status 2 and direct API response for rejected address cache', async () => {
        const chronik = createChronikMock({
            addressHistory: createHistoryPage({
                txs: [createTx({ txid: 'tx-reject' })],
                numPages: 1,
                numTxs: 1,
            }),
        });
        harness = await createCacheHarness({ chronik });

        harness.cache._setCacheStatus(address, CACHE_STATUS.REJECT, false);

        const result = await harness.cache.getAddressHistory(address, 0, 50);

        assert.equal(result.status, 2);
        assert.equal(result.txs[0].txid, 'tx-reject');
        assert.equal(chronik.state.addressCalls.length, 1);
    });

    it('returns status 1 when address cache is warming and page size is greater than 200', async () => {
        harness = await createCacheHarness();
        let updateTriggered = 0;

        harness.cache._quickGetTxCount = async () => 500;
        harness.cache._checkAndUpdateCache = () => {
            updateTriggered += 1;
        };
        harness.cache._readCache = async () => null;
        harness.cache._getGlobalMetadata = async () => null;

        const result = await harness.cache.getAddressHistory(address, 0, 500);

        assert.equal(result.status, 1);
        assert.match(result.message, /Cache is being prepared/);
        assert.equal(updateTriggered, 1);
    });

    it('returns status 3 and falls back to chronik when address cache is not latest', async () => {
        const chronik = createChronikMock({
            addressHistory: createHistoryPage({
                txs: [createTx({ txid: 'tx-fallback' })],
                numPages: 1,
                numTxs: 1,
            }),
        });
        harness = await createCacheHarness({ chronik });

        harness.cache._quickGetTxCount = async () => 1;
        harness.cache._checkAndUpdateCache = () => {};
        harness.cache._readCache = async () => null;
        harness.cache._getGlobalMetadata = async () => null;

        const result = await harness.cache.getAddressHistory(address, 0, 50);

        assert.equal(result.status, 3);
        assert.equal(result.txs[0].txid, 'tx-fallback');
        assert.equal(chronik.state.addressCalls.length, 1);
    });

    it('uses cached page when address cache is latest', async () => {
        let resetCalls = 0;
        harness = await createCacheHarness({
            wsManager: {
                getRemainingTime: () => ({ active: true }),
                resetWsTimer: () => {
                    resetCalls += 1;
                },
                unsubscribeAddress: () => {},
                unsubscribeToken: () => {},
                unsubscribeAll: () => {},
                initWebsocketForAddress: async () => {},
                initWebsocketForToken: async () => {},
                wsSubscriptions: new Map(),
            },
        });

        harness.cache._setCacheStatus(address, CACHE_STATUS.LATEST, false);
        harness.cache._readCache = async () => ({ txMap: {}, txOrder: [], numTxs: 1 });
        harness.cache._getGlobalMetadata = async () => ({ numTxs: 1, dataHash: 'hash' });
        harness.cache._getPageFromCache = async () => createHistoryPage({
            txs: [createTx({ txid: 'tx-cached' })],
            numPages: 1,
            numTxs: 1,
        });

        const result = await harness.cache.getAddressHistory(address, 0, 50);

        assert.equal(result.txs[0].txid, 'tx-cached');
        assert.equal(resetCalls, 1);
    });

    it('returns status 3 and falls back to chronik for token history when cache is not latest', async () => {
        const chronik = createChronikMock({
            tokenHistory: createHistoryPage({
                txs: [createTx({ txid: 'tx-token-fallback' })],
                numPages: 1,
                numTxs: 1,
            }),
        });
        harness = await createCacheHarness({ chronik });

        harness.cache._quickGetTxCount = async () => 1;
        harness.cache._checkAndUpdateTokenCache = () => {};
        harness.cache._readCache = async () => null;
        harness.cache._getGlobalMetadata = async () => null;

        const result = await harness.cache.getTokenHistory(tokenId, 0, 50);

        assert.equal(result.status, 3);
        assert.equal(result.txs[0].txid, 'tx-token-fallback');
        assert.equal(chronik.state.tokenCalls.length, 1);
    });

    it('returns status 2 and direct API response for rejected token cache', async () => {
        const chronik = createChronikMock({
            tokenHistory: createHistoryPage({
                txs: [createTx({ txid: 'tx-token-reject' })],
                numPages: 1,
                numTxs: 1,
            }),
        });
        harness = await createCacheHarness({ chronik });

        harness.cache._setCacheStatus(tokenId, CACHE_STATUS.REJECT, true);

        const result = await harness.cache.getTokenHistory(tokenId, 0, 50);

        assert.equal(result.status, 2);
        assert.equal(result.txs[0].txid, 'tx-token-reject');
    });

    it('returns status 1 when token cache is warming and page size is greater than 200', async () => {
        harness = await createCacheHarness();
        let updateTriggered = 0;

        harness.cache._quickGetTxCount = async () => 500;
        harness.cache._checkAndUpdateTokenCache = () => {
            updateTriggered += 1;
        };
        harness.cache._readCache = async () => null;
        harness.cache._getGlobalMetadata = async () => null;

        const result = await harness.cache.getTokenHistory(tokenId, 0, 500);

        assert.equal(result.status, 1);
        assert.match(result.message, /Cache is being prepared/);
        assert.equal(updateTriggered, 1);
    });

    it('clears address cache and unsubscribes the websocket', async () => {
        let deleted = [];
        let unsubscribed = null;
        harness = await createCacheHarness({
            db: {
                deletePaginated: async key => {
                    deleted.push(key);
                },
                clear: async () => {},
                clearTokenCache: async () => {},
                get: async () => null,
                put: async () => {},
                del: async () => {},
                updateGlobalMetadata: async () => {},
                getGlobalMetadata: async () => null,
                calculateCacheSize: async () => 0,
                db: { async *iterator() {} },
            },
            wsManager: {
                getRemainingTime: () => ({ active: false }),
                resetWsTimer: () => {},
                unsubscribeAddress: value => {
                    unsubscribed = value;
                },
                unsubscribeToken: () => {},
                unsubscribeAll: () => {},
                initWebsocketForAddress: async () => {},
                initWebsocketForToken: async () => {},
                wsSubscriptions: new Map(),
            },
        });

        await harness.cache.clearAddressCache(address);

        assert.deepStrictEqual(deleted, [`${address}:txMap`, `${address}:txOrder`]);
        assert.equal(unsubscribed, address);
        assert.equal(harness.cache.getCacheStatus(address), CACHE_STATUS.UNKNOWN);
    });

    it('clears token cache and unsubscribes token websocket', async () => {
        let cleared = null;
        let unsubscribed = null;
        harness = await createCacheHarness({
            db: {
                clearTokenCache: async key => {
                    cleared = key;
                },
                deletePaginated: async () => {},
                clear: async () => {},
                get: async () => null,
                put: async () => {},
                del: async () => {},
                updateGlobalMetadata: async () => {},
                getGlobalMetadata: async () => null,
                calculateCacheSize: async () => 0,
                db: { async *iterator() {} },
            },
            wsManager: {
                getRemainingTime: () => ({ active: false }),
                resetWsTimer: () => {},
                unsubscribeAddress: () => {},
                unsubscribeToken: value => {
                    unsubscribed = value;
                },
                unsubscribeAll: () => {},
                initWebsocketForAddress: async () => {},
                initWebsocketForToken: async () => {},
                wsSubscriptions: new Map(),
            },
        });

        await harness.cache.clearTokenCache(tokenId);

        assert.equal(cleared, tokenId);
        assert.equal(unsubscribed, tokenId);
        assert.equal(harness.cache.getCacheStatus(tokenId, true), CACHE_STATUS.UNKNOWN);
    });

    it('clears all cache and resets address and token statuses', async () => {
        let cleared = 0;
        let unsubscribedAll = 0;
        harness = await createCacheHarness({
            db: {
                clear: async () => {
                    cleared += 1;
                },
                clearTokenCache: async () => {},
                deletePaginated: async () => {},
                get: async () => null,
                put: async () => {},
                del: async () => {},
                updateGlobalMetadata: async () => {},
                getGlobalMetadata: async () => null,
                calculateCacheSize: async () => 0,
                db: { async *iterator() {} },
            },
            wsManager: {
                getRemainingTime: () => ({ active: false }),
                resetWsTimer: () => {},
                unsubscribeAddress: () => {},
                unsubscribeToken: () => {},
                unsubscribeAll: () => {
                    unsubscribedAll += 1;
                },
                initWebsocketForAddress: async () => {},
                initWebsocketForToken: async () => {},
                wsSubscriptions: new Map(),
            },
        });

        harness.cache._setCacheStatus(address, CACHE_STATUS.LATEST, false);
        harness.cache._setCacheStatus(tokenId, CACHE_STATUS.LATEST, true);

        await harness.cache.clearAllCache();

        assert.equal(cleared, 1);
        assert.equal(unsubscribedAll, 1);
        assert.equal(harness.cache.getCacheStatus(address), CACHE_STATUS.UNKNOWN);
        assert.equal(harness.cache.getCacheStatus(tokenId, true), CACHE_STATUS.UNKNOWN);
    });

    it('reports UPDATING when an address update lock exists', async () => {
        harness = await createCacheHarness();
        harness.cache._setCacheStatus(address, CACHE_STATUS.LATEST, false);
        harness.cache.updateLocks.set(address, true);

        assert.equal(harness.cache.getCacheStatus(address), CACHE_STATUS.UPDATING);
    });

    it('falls back to chronik when latest cache page is missing', async () => {
        const chronik = createChronikMock({
            addressHistory: createHistoryPage({
                txs: [createTx({ txid: 'tx-latest-fallback' })],
                numPages: 1,
                numTxs: 1,
            }),
        });
        harness = await createCacheHarness({ chronik });

        harness.cache._setCacheStatus(address, CACHE_STATUS.LATEST, false);
        harness.cache._readCache = async () => ({ txMap: {}, txOrder: [], numTxs: 1 });
        harness.cache._getGlobalMetadata = async () => ({ numTxs: 1, dataHash: 'hash' });
        harness.cache._getPageFromCache = async () => null;

        const result = await harness.cache.getAddressHistory(address, 0, 50);

        assert.equal(result.status, 3);
        assert.equal(result.txs[0].txid, 'tx-latest-fallback');
    });

    it('delegates script history to getAddressHistory with encoded address', async () => {
        harness = await createCacheHarness();
        const hash = 'f5f740bc76e56b77bcab8b4d7f888167f416fc68';
        const expectedAddress = encodeCashAddress('ecash', 'p2pkh', hash);
        let calledWith = null;

        harness.cache.getAddressHistory = async (receivedAddress, pageOffset, pageSize) => {
            calledWith = { receivedAddress, pageOffset, pageSize };
            return createHistoryPage({ txs: [createTx({ txid: 'tx-script' })] });
        };

        const result = await harness.cache.script('p2pkh', hash).history(1, 25);

        assert.equal(result.txs[0].txid, 'tx-script');
        assert.deepStrictEqual(calledWith, {
            receivedAddress: expectedAddress,
            pageOffset: 1,
            pageSize: 25,
        });
    });

    it('forwards unknown chronik methods and adds status 3', async () => {
        const chronik = createChronikMock();
        chronik.blockchainInfo = async () => ({
            tipHash: 'abc',
            tipHeight: 123,
        });

        harness = await createCacheHarness({ chronik, overrideDeps: false });

        const result = await harness.cache.blockchainInfo();

        assert.equal(result.status, 3);
        assert.equal(result.tipHeight, 123);
    });

    it('delegates getStatistics to the stats helper', async () => {
        const expected = { ok: true };
        harness = await createCacheHarness({
            stats: {
                getStatistics: async () => expected,
            },
        });

        const result = await harness.cache.getStatistics();

        assert.deepStrictEqual(result, expected);
    });
});
