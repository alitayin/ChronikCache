const DbUtils = require('./lib/dbUtils');
const WebSocketManager = require('./lib/WebSocketManager');
const Logger = require('./lib/Logger');
const { encodeCashAddress } = require('ecashaddrjs');
const { CACHE_STATUS, DEFAULT_CONFIG } = require('./constants');
const FailoverHandler = require('./lib/failover');

class ChronikCache {
    constructor(chronik, {
        maxMemory = DEFAULT_CONFIG.MAX_MEMORY,
        maxCacheSize = DEFAULT_CONFIG.MAX_CACHE_SIZE,
        failoverOptions = {},
        enableLogging = true,
        wsTimeout = DEFAULT_CONFIG.WS_TIMEOUT,
        wsExtendTimeout = DEFAULT_CONFIG.WS_EXTEND_TIMEOUT
    } = {}) {
        this.chronik = chronik;
        this.maxMemory = maxMemory;  
        this.defaultPageSize = DEFAULT_CONFIG.DEFAULT_PAGE_SIZE;
        this.cacheDir = DEFAULT_CONFIG.CACHE_DIR;
        this.maxCacheSize = maxCacheSize * 1024 * 1024;  
        this.enableLogging = enableLogging;

        this.logger = new Logger(enableLogging);

        // Initialize database utilities
        this.db = new DbUtils(this.cacheDir, {
            valueEncoding: 'json',
            maxCacheSize: this.maxCacheSize,
            enableLogging
        });

        this.txCache = new Map();
        this.statusMap = new Map();
        this.wsManager = new WebSocketManager(chronik, failoverOptions, enableLogging, {
            wsTimeout,
            wsExtendTimeout
        });
        this.updateLocks = new Map();

        // Add script type to address cache mapping
        this.scriptToAddressMap = new Map();

        // Add failover handler
        this.failover = new FailoverHandler(failoverOptions);

        // 添加token缓存相关的Map
        this.tokenStatusMap = new Map();
        this.tokenUpdateLocks = new Map();
    }

    // Read cache from database
    async _readCache(address) {
        const cache = await this.db.get(address);
        if (!cache || !cache.txMap || !cache.txOrder || !cache.numPages || !cache.numTxs) {
            return null;
        }

        // Update metadata access information
        const now = Date.now();
        cache.metadata = cache.metadata || {};
        cache.metadata.accessCount = (cache.metadata.accessCount || 0) + 1;
        cache.metadata.lastAccessAt = now;

        // Asynchronously write back to database
        this.db.put(address, cache);

        return cache;
    }

    // 写入缓存
    async _writeCache(address, data) {
        let existingCache = await this.db.get(address);
        const now = Date.now();

        const cacheData = {
            txMap: data.txMap,
            txOrder: data.txOrder,
            numPages: data.numPages,
            numTxs: data.numTxs,
            metadata: {
                createdAt: existingCache?.metadata?.createdAt || now,
                accessCount: existingCache?.metadata?.accessCount || 0,
                lastAccessAt: existingCache?.metadata?.lastAccessAt || now,
                updatedAt: now
            }
        };

        // Check cache size and clean if necessary
        const currentSize = await this.db.calculateCacheSize();
        if (currentSize > this.maxCacheSize) {
            this.logger.log('Cache size exceeded limit, cleaning least accessed entries...');
            await this.db.cleanLeastAccessedCache();
        }

        await this.db.put(address, cacheData);
        this.logger.log(`Cache written for ${address}`);
    }

    /* --------------------- 初始化 WebSocket --------------------- */

    async _initWebsocketForAddress(address) {
        // Use failover's handleWebSocketOperation to handle WebSocket initialization
        return await this.failover.handleWebSocketOperation(async () => {
            this.wsManager.resetWsTimer(address, (addr) => {
                this._setCacheStatus(addr, CACHE_STATUS.UNKNOWN);
            });

            await this.wsManager.initWebsocketForAddress(address, async (addr) => {
                const result = await this.chronik.address(addr).history(0, 1);
                await this._updateCache(addr, result.numTxs, this.defaultPageSize);
            });
        }, address, 'WebSocket initialization');
    }

    /* --------------------- 缓存状态管理方法 --------------------- */

    _getCacheStatus(address) {
        if (this._isUpdating(address)) {
            return CACHE_STATUS.UPDATING;
        }

        const status = this.statusMap.get(address);
        if (!status) {
            return CACHE_STATUS.UNKNOWN;
        }

        return status.status;
    }

    _setCacheStatus(address, status) {
        const now = Date.now();
        const existingStatus = this.statusMap.get(address) || {};
        this.statusMap.set(address, {
            status,
            cacheTimestamp: existingStatus.cacheTimestamp || now
        });
    }

    /* --------------------- Core Cache Update Logic --------------------- */

    _isUpdating(address) {
        return this.updateLocks.has(address);
    }

    _checkAndUpdateCache(address, apiNumTxs, pageSize) {
        if (apiNumTxs > this.maxMemory) {
            this.logger.log(`[${address}] Transaction count (${apiNumTxs}) exceeds maxMemory limit (${this.maxMemory}), skipping cache`);
            this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
            return;
        }

        if (this._isUpdating(address)) {
            this.logger.log(`[${address}] Cache update already in progress, skipping`);
            return;
        }

        Promise.resolve().then(async () => {
            try {
                const cachedData = await this._readCache(address);
                if (!cachedData || cachedData.numTxs !== apiNumTxs) {
                    this.updateLocks.set(address, true);
                    try {
                        this.logger.log(`[${address}] Cache needs update, changing status to UPDATING`);
                        await this._updateCache(address, apiNumTxs, pageSize);
                    } finally {
                        this.updateLocks.delete(address);
                    }
                } else {
                    this.logger.log(`[${address}] Cache is up to date, setting status to LATEST`);
                    this._setCacheStatus(address, CACHE_STATUS.LATEST);
                    await this._initWebsocketForAddress(address);
                }
            } catch (error) {
                this.logger.error('Cache update error:', error);
                this.logger.log(`[${address}] Error occurred, setting status to UNKNOWN`);
                this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
            }
        });
    }

    async _updateCache(address, totalNumTxs, pageSize) {
        return await this.failover.executeWithRetry(async () => {
            try {
                if (totalNumTxs > this.maxMemory) {
                    this.logger.log(`[${address}] Transaction count (${totalNumTxs}) exceeds maxMemory limit (${this.maxMemory}), aborting cache update`);
                    this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
                    return;
                }

                this.logger.log(`[${address}] Starting cache update`);
                let currentPage = 0;

                while (true) {
                    // Reload cache on each iteration to get actual transaction count
                    const existingCache = await this._readCache(address);
                    const txMap = new Map(Object.entries(existingCache?.txMap || {}));
                    const currentSize = txMap.size;

                    this.logger.log(`Updating cache page ${currentPage}, current size: ${currentSize}/${totalNumTxs}`);
                    
                    if (currentSize >= totalNumTxs) {
                        this.logger.log(`Cache update completed, final size: ${currentSize}`);
                        break;
                    }

                    const result = await this.chronik.address(address).history(currentPage, pageSize);

                    // Merge new data
                    result.txs.forEach(tx => {
                        if (!txMap.has(tx.txid)) {
                            txMap.set(tx.txid, tx);
                        }
                    });

                    // Update cache file
                    const updatedData = {
                        txMap: Object.fromEntries(txMap),
                        txOrder: Array.from(txMap.keys()),
                        numPages: Math.ceil(txMap.size / pageSize),
                        numTxs: txMap.size
                    };
                    await this._writeCache(address, updatedData);

                    currentPage++;
                }

                // Check if cache status needs to be set to LATEST after update completion
                const currentStatus = this._getCacheStatus(address);
                if (currentStatus !== CACHE_STATUS.LATEST) {
                    this.logger.log(`[${address}] Cache update complete, setting status to LATEST`);
                    this._setCacheStatus(address, CACHE_STATUS.LATEST);

                    await this._initWebsocketForAddress(address);
                } else {
                    this.logger.log(`[${address}] Cache update complete, maintaining LATEST status`);
                }
            } catch (error) {
                this.logger.error('[Cache] Error in _updateCache:', error);
                throw error;
            }
        }, `updateCache for ${address}`);
    }

    /* --------------------- Script Related Methods --------------------- */

    // Convert script parameters to ecash address
    _convertScriptToAddress(type, hash) {
        try {
            // Ensure hash is lowercase
            hash = hash.toLowerCase();
            // Use ecashaddrjs to convert script to ecash address
            const address = encodeCashAddress('ecash', type, hash);
            // Cache script to address mapping
            const scriptKey = `${type}:${hash}`;
            this.scriptToAddressMap.set(scriptKey, address);
            return address;
        } catch (error) {
            this.logger.error('Error converting script to address:', error);
            throw error;
        }
    }

    // Fluent interface for script method
    script(type, hash) {
        return {
            history: async (pageOffset = 0, pageSize = 200) => {
                // Convert script to address and use existing address query logic
                const address = this._convertScriptToAddress(type, hash);
                return await this.getAddressHistory(address, pageOffset, pageSize);
            }
            // Add other script-related methods here if needed
        };
    }

    /* --------------------- External Interface Methods --------------------- */

    async clearAddressCache(address) {
        // Delete local cache entry for the address
        await this.db.del(address);
        // Close WebSocket connection for this address
        this.wsManager.unsubscribeAddress(address);
        // Update status to UNKNOWN after clearing cache
        this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
        this.logger.log(`Cache cleared for address: ${address}`);
    }

    async clearAllCache() {
        try {
            // Clear all local cache
            await this.db.clear();
            // Close all WebSocket connections
            this.wsManager.unsubscribeAll();

            // Update cache status to UNKNOWN for each address
            this.statusMap.forEach((_, addr) => {
                this._setCacheStatus(addr, CACHE_STATUS.UNKNOWN);
            });
            this.logger.log('All cache cleared successfully');
        } catch (error) {
            this.logger.error('Error clearing all cache:', error);
        }
    }

    async getAddressHistory(address, pageOffset = 0, pageSize = 200) {
        return await this.failover.executeWithRetry(async () => {
            try {
                const apiPageSize = Math.min(200, pageSize);
                const cachePageSize = Math.min(4000, pageSize);

                const currentStatus = this._getCacheStatus(address);
                const cachedData = await this._readCache(address);
                const cachedCount = cachedData ? cachedData.numTxs : 0;

                this.logger.log(`[${address}] Cache status: ${currentStatus}, Cached txs: ${cachedCount}`);
                
                const wsTimeInfo = this.wsManager.getRemainingTime(address);
                if (wsTimeInfo.active) {
                    this.logger.log(`[${address}] WebSocket remaining time: ${wsTimeInfo.remainingSec} seconds`);
                } else {
                    this.logger.log(`[${address}] ${wsTimeInfo.message}`);
                    if (currentStatus === CACHE_STATUS.LATEST) {
                        await this._initWebsocketForAddress(address);
                    }
                }

                if (currentStatus === CACHE_STATUS.LATEST) {
                    this.wsManager.resetWsTimer(address);
                }

                if (currentStatus !== CACHE_STATUS.LATEST) {
                    // 使用传入的 pageOffset
                    const apiResult = await this.chronik.address(address).history(pageOffset, apiPageSize);
                    this.logger.log(`[${address}] API txs count: ${apiResult.numTxs}`);
                    if (currentStatus !== CACHE_STATUS.UPDATING) {
                        this._checkAndUpdateCache(address, apiResult.numTxs, this.defaultPageSize);
                    }

                    // 如果请求的 pageSize 大于 200，返回提示信息
                    if (pageSize > 200) {
                        return {
                            message: "Cache is being prepared. Please wait for cache to be ready when requesting more than 200 transactions.",
                            numTxs: 0,
                            txs: [],
                            numPages: 0
                        };
                    }
                    
                    return apiResult;
                }

                const cachedResult = await this._getPageFromCache(address, pageOffset, cachePageSize);
                if (cachedResult) {
                    return cachedResult;
                }
                const apiFallback = await this.chronik.address(address).history(pageOffset, apiPageSize);
                this.logger.log(`[${address}] API txs count (fallback): ${apiFallback.numTxs}`);
                return apiFallback;
            } catch (error) {
                this.logger.error('[Cache] Error in getAddressHistory:', error);
                throw error;
            }
        }, `getAddressHistory for ${address}`);
    }

    async _fetchAllHistory(address) {
        try {
            let allTxs = [];
            let currentPage = 0;
            let hasMorePages = true;

            while (hasMorePages) {
                this.logger.log(`Fetching page ${currentPage}...`);
                const result = await this.chronik.address(address).history(currentPage, this.defaultPageSize);
                allTxs = allTxs.concat(result.txs);
                hasMorePages = currentPage + 1 < result.numPages;
                currentPage++;
            }

            return {
                txs: allTxs,
                numPages: currentPage,
                numTxs: allTxs.length
            };
        } catch (error) {
            this.logger.error('Error fetching all history:', error);
            throw error;
        }
    }

    _getPageFromFullData(fullData, page, pageSize) {
        const start = page * pageSize;
        const end = start + pageSize;
        const paginatedTxs = fullData.txs.slice(start, end);
        return {
            txs: paginatedTxs,
            numPages: Math.ceil(fullData.txs.length / pageSize),
            numTxs: fullData.txs.length
        };
    }

    async _getPageFromCache(address, pageOffset, pageSize) {
        const cache = await this._readCache(address);
        if (!cache) return null;

        const start = pageOffset * pageSize;
        const end = start + pageSize;
        const txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        return {
            txs,
            numPages: cache.numPages,
            numTxs: cache.numTxs
        };
    }

    address(address) {
        return {
            history: async (pageOffset = 0, pageSize = 200) => {
                return await this.getAddressHistory(address, pageOffset, pageSize);
            }
            // Add other methods here if needed
        };
    }

    /* --------------------- Token Related Methods --------------------- */

    _getTokenCacheStatus(tokenId) {
        if (this._isTokenUpdating(tokenId)) {
            return CACHE_STATUS.UPDATING;
        }

        const status = this.tokenStatusMap.get(tokenId);
        if (!status) {
            return CACHE_STATUS.UNKNOWN;
        }

        return status.status;
    }

    _setTokenCacheStatus(tokenId, status) {
        const now = Date.now();
        const existingStatus = this.tokenStatusMap.get(tokenId) || {};
        this.tokenStatusMap.set(tokenId, {
            status,
            cacheTimestamp: existingStatus.cacheTimestamp || now
        });
    }

    _isTokenUpdating(tokenId) {
        return this.tokenUpdateLocks.has(tokenId);
    }

    async _checkAndUpdateTokenCache(tokenId, apiNumTxs, pageSize) {
        if (apiNumTxs > this.maxMemory) {
            this.logger.log(`[Token ${tokenId}] Transaction count (${apiNumTxs}) exceeds maxMemory limit (${this.maxMemory}), skipping cache`);
            this._setTokenCacheStatus(tokenId, CACHE_STATUS.UNKNOWN);
            return;
        }

        if (this._isTokenUpdating(tokenId)) {
            this.logger.log(`[Token ${tokenId}] Cache update already in progress, skipping`);
            return;
        }

        Promise.resolve().then(async () => {
            try {
                const cachedData = await this._readCache(tokenId);
                if (!cachedData || cachedData.numTxs !== apiNumTxs) {
                    this.tokenUpdateLocks.set(tokenId, true);
                    try {
                        this.logger.log(`[Token ${tokenId}] Cache needs update, changing status to UPDATING`);
                        await this._updateTokenCache(tokenId, apiNumTxs, pageSize);
                    } finally {
                        this.tokenUpdateLocks.delete(tokenId);
                    }
                } else {
                    this.logger.log(`[Token ${tokenId}] Cache is up to date, setting status to LATEST`);
                    this._setTokenCacheStatus(tokenId, CACHE_STATUS.LATEST);
                }
            } catch (error) {
                this.logger.error('Token cache update error:', error);
                this.logger.log(`[Token ${tokenId}] Error occurred, setting status to UNKNOWN`);
                this._setTokenCacheStatus(tokenId, CACHE_STATUS.UNKNOWN);
            }
        });
    }

    async _updateTokenCache(tokenId, totalNumTxs, pageSize) {
        return await this.failover.executeWithRetry(async () => {
            try {
                if (totalNumTxs > this.maxMemory) {
                    this.logger.log(`[${tokenId}] Transaction count (${totalNumTxs}) exceeds maxMemory limit (${this.maxMemory}), aborting cache update`);
                    this._setTokenCacheStatus(tokenId, CACHE_STATUS.UNKNOWN);
                    return;
                }

                this.logger.log(`[${tokenId}] Starting cache update`);
                let currentPage = 0;

                while (true) {
                    // Reload cache on each iteration to get actual transaction count
                    const existingCache = await this._readCache(tokenId);
                    const txMap = new Map(Object.entries(existingCache?.txMap || {}));
                    const currentSize = txMap.size;

                    this.logger.log(`Updating cache page ${currentPage}, current size: ${currentSize}/${totalNumTxs}`);
                    
                    if (currentSize >= totalNumTxs) {
                        this.logger.log(`Cache update completed, final size: ${currentSize}`);
                        break;
                    }

                    const result = await this.chronik.tokenId(tokenId).history(currentPage, pageSize);

                    result.txs.forEach(tx => {
                        if (!txMap.has(tx.txid)) {
                            txMap.set(tx.txid, tx);
                        }
                    });

                    const updatedData = {
                        txMap: Object.fromEntries(txMap),
                        txOrder: Array.from(txMap.keys()),
                        numPages: Math.ceil(txMap.size / pageSize),
                        numTxs: txMap.size
                    };
                    await this._writeCache(tokenId, updatedData);

                    currentPage++;
                }

                this._setTokenCacheStatus(tokenId, CACHE_STATUS.LATEST);
            } catch (error) {
                this.logger.error('[Cache] Error in _updateTokenCache:', error);
                throw error;
            }
        }, `updateTokenCache for ${tokenId}`);
    }

    async getTokenHistory(tokenId, pageOffset = 0, pageSize = 200) {
        return await this.failover.executeWithRetry(async () => {
            try {
                const apiPageSize = Math.min(200, pageSize);
                const cachePageSize = Math.min(4000, pageSize);

                const currentStatus = this._getTokenCacheStatus(tokenId);
                const cachedData = await this._readCache(tokenId);
                const cachedCount = cachedData ? cachedData.numTxs : 0;

                this.logger.log(`[Token ${tokenId}] Cache status: ${currentStatus}, Cached txs: ${cachedCount}`);

                if (currentStatus !== CACHE_STATUS.LATEST) {
                    const apiResult = await this.chronik.tokenId(tokenId).history(pageOffset, apiPageSize);
                    this.logger.log(`[Token ${tokenId}] API txs count: ${apiResult.numTxs}`);
                    if (currentStatus !== CACHE_STATUS.UPDATING) {
                        this._checkAndUpdateTokenCache(tokenId, apiResult.numTxs, this.defaultPageSize);
                    }

                    if (pageSize > 200) {
                        return {
                            message: "Cache is being prepared. Please wait for cache to be ready when requesting more than 200 transactions.",
                            numTxs: 0,
                            txs: [],
                            numPages: 0
                        };
                    }
                    
                    return apiResult;
                }

                const cachedResult = await this._getPageFromCache(tokenId, pageOffset, cachePageSize);
                if (cachedResult) {
                    return cachedResult;
                }
                const apiFallback = await this.chronik.tokenId(tokenId).history(pageOffset, apiPageSize);
                this.logger.log(`[Token ${tokenId}] API txs count (fallback): ${apiFallback.numTxs}`);
                return apiFallback;
            } catch (error) {
                this.logger.error('[Cache] Error in getTokenHistory:', error);
                throw error;
            }
        }, `getTokenHistory for ${tokenId}`);
    }

    tokenId(tokenId) {
        return {
            history: async (pageOffset = 0, pageSize = 200) => {
                return await this.getTokenHistory(tokenId, pageOffset, pageSize);
            }
        };
    }
}

module.exports = ChronikCache; 