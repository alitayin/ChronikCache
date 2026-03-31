const ChronikCache = require('../../src/index.ts');

function createTx(overrides = {}) {
    return {
        txid: 'tx-default',
        version: 2,
        inputs: [],
        outputs: [],
        lockTime: 0,
        timeFirstSeen: 0,
        size: 100,
        isCoinbase: false,
        isFinal: false,
        tokenEntries: [],
        tokenFailedParsings: [],
        tokenStatus: 'TOKEN_STATUS_NON_TOKEN',
        ...overrides,
    };
}

function createHistoryPage(overrides = {}) {
    return {
        txs: [],
        numPages: 0,
        numTxs: 0,
        ...overrides,
    };
}

function createWsMock() {
    return {
        subscribedAddresses: [],
        unsubscribedAddresses: [],
        subscribedTokenIds: [],
        unsubscribedTokenIds: [],
        readyState: 1,
        manuallyClosed: false,
        subscribeToAddress(address) {
            this.subscribedAddresses.push(address);
        },
        unsubscribeFromAddress(address) {
            this.unsubscribedAddresses.push(address);
        },
        subscribeToTokenId(tokenId) {
            this.subscribedTokenIds.push(tokenId);
        },
        unsubscribeFromTokenId(tokenId) {
            this.unsubscribedTokenIds.push(tokenId);
        },
        close() {
            this.manuallyClosed = true;
        },
        async waitForOpen() {},
    };
}

function createChronikMock(options = {}) {
    const state = {
        addressCalls: [],
        tokenCalls: [],
        txCalls: [],
        wsConfigs: [],
        wsInstances: [],
    };

    const resolveValue = async (valueOrFactory, ...args) => {
        if (typeof valueOrFactory === 'function') {
            return await valueOrFactory(...args);
        }
        return valueOrFactory;
    };

    const chronik = {
        state,
        address(address) {
            return {
                history: async (pageOffset = 0, pageSize = 200) => {
                    state.addressCalls.push({ address, pageOffset, pageSize });
                    return await resolveValue(
                        options.addressHistory || createHistoryPage(),
                        address,
                        pageOffset,
                        pageSize,
                    );
                },
            };
        },
        tokenId(tokenId) {
            return {
                history: async (pageOffset = 0, pageSize = 200) => {
                    state.tokenCalls.push({ tokenId, pageOffset, pageSize });
                    return await resolveValue(
                        options.tokenHistory || createHistoryPage(),
                        tokenId,
                        pageOffset,
                        pageSize,
                    );
                },
            };
        },
        async tx(txid) {
            state.txCalls.push(txid);
            if (options.txById && txid in options.txById) {
                return await resolveValue(options.txById[txid], txid);
            }
            return createTx({ txid });
        },
        ws(config) {
            state.wsConfigs.push(config);
            const ws = options.wsFactory ? options.wsFactory(config) : createWsMock();
            state.wsInstances.push(ws);
            return ws;
        },
    };

    return chronik;
}

async function createCacheHarness(options = {}) {
    const chronik = options.chronik || createChronikMock();
    const cache = new ChronikCache(chronik, {
        enableLogging: false,
        ...(options.config || {}),
    });

    const originalDb = cache.db;

    if (options.overrideDeps !== false) {
        cache.db = options.db || {
            clearTokenCache: async () => {},
            deletePaginated: async () => {},
            clear: async () => {},
            get: async () => null,
            put: async () => {},
            del: async () => {},
            updateGlobalMetadata: async () => {},
            getGlobalMetadata: async () => null,
            calculateCacheSize: async () => 0,
            db: {
                async *iterator() {},
            },
        };

        cache.wsManager = options.wsManager || {
            getRemainingTime: () => ({ active: false }),
            resetWsTimer: () => {},
            unsubscribeAddress: () => {},
            unsubscribeToken: () => {},
            unsubscribeAll: () => {},
            initWebsocketForAddress: async () => {},
            initWebsocketForToken: async () => {},
            wsSubscriptions: new Map(),
        };

        cache.failover = options.failover || {
            executeWithRetry: async fn => await fn(),
            handleWebSocketOperation: async fn => await fn(),
        };

        cache.logger = options.logger || {
            log: () => {},
            error: () => {},
            startTimer: () => {},
            endTimer: () => {},
        };

        cache.stats = options.stats || {
            getStatistics: async () => ({}),
        };
    }

    return {
        cache,
        chronik,
        async cleanup() {
            cache.destroy();
            if (originalDb?.db?.close) {
                await originalDb.db.close();
            }
        },
    };
}

module.exports = {
    createTx,
    createHistoryPage,
    createWsMock,
    createChronikMock,
    createCacheHarness,
};
