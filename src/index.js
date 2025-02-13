const DbUtils = require('./lib/dbUtils');
const WebSocketManager = require('./lib/WebSocketManager');
const Logger = require('./lib/Logger');
const { encodeCashAddress } = require('ecashaddrjs');
const { CACHE_STATUS, DEFAULT_CONFIG } = require('./constants');
const FailoverHandler = require('./lib/failover');
const MAX_ITEMS_PER_KEY = DEFAULT_CONFIG.MAX_ITEMS_PER_KEY; 
const { computeHash } = require('./lib/hash');
const TaskQueue = require('./lib/TaskQueue');
// Import external sortTxIds function from lib
const sortTxIds = require('./lib/sortTxIds');


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
        // 初始化全局元数据缓存，防止频繁访问数据库
        this.globalMetadataCache = new Map();
        // Set LRU cache limit for global metadata cache
        this.globalMetadataCacheLimit = DEFAULT_CONFIG.GLOBAL_METADATA_CACHE_LIMIT || 100;
        // 初始化全局任务队列，最大并发 2 个
        this.updateQueue = new TaskQueue(2);
        return new Proxy(this, {
            get: (target, prop) => {
                // 如果是 ChronikCache 自己的方法或属性，直接返回
                if (prop in target) {
                    return target[prop];
                }
                // 如果底层 chronik 有这个方法，则传递调用
                if (typeof chronik[prop] === 'function') {
                    return (...args) => {
                        this.logger.log(`Forwarding uncached method call: ${prop}`);
                        return chronik[prop](...args);
                    };
                }
                // 如果底层 chronik 有这个属性，返回属性值
                if (prop in chronik) {
                    return chronik[prop];
                }
                return undefined;
            }
        });
    }


    // Read cache from database by reading txMap and txOrder separately
    async _readCache(addressOrTokenId) {
        try {
            let txOrder, txMap;

            // Check for paginated txOrder
            let txOrderMeta = await this.db.get(`${addressOrTokenId}:txOrder:meta`);
            if (txOrderMeta) {
                const { pageCount } = txOrderMeta;
                txOrder = [];
                for (let i = 0; i < pageCount; i++) {
                    let chunk = await this.db.get(`${addressOrTokenId}:txOrder:${i}`);
                    txOrder = txOrder.concat(chunk);
                }
            } else {
                txOrder = await this.db.get(`${addressOrTokenId}:txOrder`);
            }
            if (!txOrder) return null;

            // Check for paginated txMap
            let txMapMeta = await this.db.get(`${addressOrTokenId}:txMap:meta`);
            if (txMapMeta) {
                const { pageCount } = txMapMeta;
                txMap = {};
                for (let i = 0; i < pageCount; i++) {
                    let chunk = await this.db.get(`${addressOrTokenId}:txMap:${i}`);
                    txMap = Object.assign(txMap, chunk);
                }
            } else {
                txMap = await this.db.get(`${addressOrTokenId}:txMap`);
            }

            // Update global metadata
            const now = Date.now();
            let metadata = await this._getGlobalMetadata(addressOrTokenId);
            if (!metadata) {
                metadata = { accessCount: 0, createdAt: now };
            }
            metadata.accessCount = (metadata.accessCount || 0) + 1;
            metadata.lastAccessAt = now;
            this._updateGlobalMetadata(addressOrTokenId, metadata);

            return { 
                txMap, 
                txOrder, 
                numTxs: (metadata.numTxs !== undefined ? metadata.numTxs : txOrder.length) 
            };
        } catch (error) {
            return null;
        }
    }
    
    // Write cache into database with pagination support if tx count exceeds MAX_ITEMS_PER_KEY
    async _writeCache(addressOrTokenId, data, isToken = false) {
        // Use computeHash to generate hash value
        const newHash = computeHash(data.txOrder);

        // Try to get the existing hash from global metadata
        let metadata = await this._getGlobalMetadata(addressOrTokenId, isToken);

        // Log the change of hash values
        if (metadata && metadata.dataHash) {
            this.logger.log(`[${addressOrTokenId}] Changing hash from ${metadata.dataHash} to ${newHash}`);
        } else {
            this.logger.log(`[${addressOrTokenId}] No previous hash found. Setting new hash: ${newHash}`);
        }

        // If there is no difference, skip the DB update
        if (metadata && metadata.dataHash && metadata.dataHash === newHash) {
            this.logger.log(`No change detected for ${isToken ? 'token' : 'address'}: ${addressOrTokenId}, skipping DB update.`);
            return;
        }

        const totalTxs = data.txOrder.length;
        if (totalTxs > MAX_ITEMS_PER_KEY) {
            const pageCount = Math.ceil(totalTxs / MAX_ITEMS_PER_KEY);
            for (let i = 0; i < pageCount; i++) {
                let chunk = data.txOrder.slice(i * MAX_ITEMS_PER_KEY, (i + 1) * MAX_ITEMS_PER_KEY);
                await this.db.put(`${addressOrTokenId}:txOrder:${i}`, chunk);
            }
            await this.db.put(`${addressOrTokenId}:txOrder:meta`, { pageCount, totalTxs });
            
            for (let i = 0; i < pageCount; i++) {
                let chunkKeys = data.txOrder.slice(i * MAX_ITEMS_PER_KEY, (i + 1) * MAX_ITEMS_PER_KEY);
                let chunkMap = {};
                for (const txid of chunkKeys) {
                    chunkMap[txid] = data.txMap[txid];
                }
                await this.db.put(`${addressOrTokenId}:txMap:${i}`, chunkMap);
            }
            await this.db.put(`${addressOrTokenId}:txMap:meta`, { pageCount, totalTxs });
        } else {
            await this.db.put(`${addressOrTokenId}:txMap`, data.txMap);
            await this.db.put(`${addressOrTokenId}:txOrder`, data.txOrder);
        }
        
        // Update global metadata with the new hash value
        metadata = metadata || { accessCount: 0, createdAt: Date.now() };
        metadata.dataHash = newHash;
        metadata.numTxs = totalTxs;
        metadata.updatedAt = Date.now();
        await this._updateGlobalMetadata(addressOrTokenId, metadata, isToken);

        this.logger.log(`Cache written for ${isToken ? 'token' : 'address'}: ${addressOrTokenId}`);
    }

    // 更新全局元数据
    async _updateGlobalMetadata(identifier, metadata, isToken = false) {
        const key = isToken ? `token:${identifier}` : `address:${identifier}`;
        await this.db.updateGlobalMetadata(key, metadata);
        // Update in-memory metadata cache with LRU ordering
        if (this.globalMetadataCache.has(key)) {
            this.globalMetadataCache.delete(key);
        }
        this.globalMetadataCache.set(key, metadata);
        this._maintainGlobalMetadataCacheLimit();
    }

    // 获取全局元数据
    async _getGlobalMetadata(identifier, isToken = false) {
        const key = isToken ? `token:${identifier}` : `address:${identifier}`;
        // Try to get from in-memory cache
        if (this.globalMetadataCache.has(key)) {
            // Update recency ordering by re-inserting the key
            const metadata = this.globalMetadataCache.get(key);
            this.globalMetadataCache.delete(key);
            this.globalMetadataCache.set(key, metadata);
            return metadata;
        }
        // Get from database and cache it if found
        const metadata = await this.db.getGlobalMetadata(key);
        if (metadata) {
            this.globalMetadataCache.set(key, metadata);
            this._maintainGlobalMetadataCacheLimit();
        }
        return metadata;
    }

    /* --------------------- 初始化 WebSocket --------------------- */

    async _initWebsocketForAddress(address) {
        return await this.failover.handleWebSocketOperation(async () => {
            this.wsManager.resetWsTimer(address, (addr) => {
                this._setCacheStatus(addr, CACHE_STATUS.UNKNOWN);
            });

            await this.wsManager.initWebsocketForAddress(address, async (addr, txid, msgType) => {
                if (msgType === 'TX_ADDED_TO_MEMPOOL') {
                    const apiNumTxs = await this._quickGetTxCount(addr, 'address');
                    await this._updateCache(addr, apiNumTxs, this.defaultPageSize);
                } else if (msgType === 'TX_FINALIZED') {
                    await this._updateUnconfirmedTx(addr, txid);
                }
            });
        }, address, 'WebSocket initialization');
    }

    async _initWebsocketForToken(tokenId) {
        return await this.failover.handleWebSocketOperation(async () => {
            this.wsManager.resetWsTimer(tokenId, (id) => {
                this._setTokenCacheStatus(id, CACHE_STATUS.UNKNOWN);
            });

            await this.wsManager.initWebsocketForToken(tokenId, async (id, txid, msgType) => {
                if (msgType === 'TX_ADDED_TO_MEMPOOL') {
                    const apiNumTxs = await this._quickGetTxCount(id, 'token');
                    await this._updateTokenCache(id, apiNumTxs, this.defaultPageSize);
                } else if (msgType === 'TX_FINALIZED') {
                    await this._updateUnconfirmedTx(id, txid);
                }
            });
        }, tokenId, 'WebSocket initialization');
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

    async _checkAndUpdateCache(address, apiNumTxs, pageSize, forceUpdate = false) {
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
                let dynamicPageSize = pageSize;
                if (cachedData && typeof cachedData.numTxs === 'number') {
                    dynamicPageSize = apiNumTxs - cachedData.numTxs;
                    if (dynamicPageSize < 1) {
                        dynamicPageSize = 1;
                    }
                }
                if (dynamicPageSize > 200) {
                    dynamicPageSize = 200;
                }
                if (!cachedData || cachedData.numTxs !== apiNumTxs || forceUpdate) {
                    this.updateLocks.set(address, true);
                    this.updateQueue.enqueue(async () => {
                        try {
                            this.logger.log(`[${address}] Cache needs update${forceUpdate ? ' (forced update)' : ''}, updating with dynamic page size: ${dynamicPageSize}`);
                            await this._updateCache(address, apiNumTxs, dynamicPageSize);
                        } finally {
                            this.updateLocks.delete(address);
                        }
                    });
                    this.logger.log(`[${address}] Current global update queue length: ${this.updateQueue.getQueueLength()}`);
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
                    this.logger.log(`[${address}] Transaction count (${totalNumTxs}) exceeds maxMemory limit (${this.maxMemory}), aborting cache update.`);
                    this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
                    return;
                }
                this.logger.log(`[${address}] Starting cache update.`);
                let currentPage = 0;
                let iterationCount = 0;
                let localCache = await this._readCache(address) || { txMap: {}, txOrder: [] };
                let localTxMap = new Map(Object.entries(localCache.txMap));
                let localTxOrder = localCache.txOrder;
                
                while (true) {
                    const currentSize = localTxMap.size;
                    this.logger.log(`[${address}] Updating cache page ${currentPage}, current size: ${currentSize}/${totalNumTxs}`);
                    
                    if (currentSize >= totalNumTxs) {
                        // Final sorting of txOrder before final cache write using the helper
                        this.logger.startTimer(`[${address}] Final sorting tx order`);
                        localTxOrder = sortTxIds(Array.from(localTxMap.keys()), key => localTxMap.get(key));
                        this.logger.endTimer(`[${address}] Final sorting tx order`);

                        // Always write the final state into the cache
                        this.logger.startTimer(`[${address}] Final write cache`);
                        const updatedData = {
                            txMap: Object.fromEntries(localTxMap),
                            txOrder: localTxOrder,
                        };
                        await this._writeCache(address, updatedData);
                        this.logger.endTimer(`[${address}] Final write cache`);

                        this.logger.log(`[${address}] Cache update completed, final size: ${currentSize}`);
                        break;
                    }
            
                    this.logger.startTimer(`[${address}] Fetch history`);
                    const result = await this.chronik.address(address).history(currentPage, pageSize);
                    this.logger.endTimer(`[${address}] Fetch history`);
            
                    this.logger.startTimer(`[${address}] Process tx`);
                    result.txs.forEach(tx => {
                        if (!localTxMap.has(tx.txid)) {
                            localTxMap.set(tx.txid, tx);
                        }
                    });
                    this.logger.endTimer(`[${address}] Process tx`);
            
                    this.logger.startTimer(`[${address}] Sorting tx order`);
                    // Use helper function to sort txOrder
                    localTxOrder = sortTxIds(Array.from(localTxMap.keys()), key => localTxMap.get(key));
                    this.logger.endTimer(`[${address}] Sorting tx order`);
            
                    if (localTxMap.size >= 20000) {
                        if (iterationCount % 10 === 0) {
                            this.logger.startTimer(`[${address}] Write cache`);
                            const updatedData = {
                                txMap: Object.fromEntries(localTxMap),
                                txOrder: localTxOrder,
                            };
                            await this._writeCache(address, updatedData);
                            this.logger.endTimer(`[${address}] Write cache`);
                        } else {
                            this.logger.log(`[${address}] Skipping DB write to reduce overhead (iteration ${iterationCount}).`);
                        }
                    } else {
                        this.logger.startTimer(`[${address}] Write cache`);
                        const updatedData = {
                            txMap: Object.fromEntries(localTxMap),
                            txOrder: localTxOrder,
                        };
                        await this._writeCache(address, updatedData);
                        this.logger.endTimer(`[${address}] Write cache`);
                    }
            
                    currentPage++;
                    iterationCount++;
                }
                
                // Clean up memory after cache update.
                this.logger.log(`[${address}] Cleaning up memory used for cache update.`);
                localTxMap.clear();
                localTxOrder = null;
            
                const currentStatus = this._getCacheStatus(address);
                if (currentStatus !== CACHE_STATUS.LATEST) {
                    this.logger.log(`[${address}] Cache update complete, setting status to LATEST.`);
                    this._setCacheStatus(address, CACHE_STATUS.LATEST);
                    await this._initWebsocketForAddress(address);
                } else {
                    this.logger.log(`[${address}] Cache update complete, maintaining LATEST status.`);
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

    // Clear cache entries for an address by deleting both keys
    async clearAddressCache(address) {
        await Promise.all([
            this.db.deletePaginated(`${address}:txMap`),
            this.db.deletePaginated(`${address}:txOrder`)
        ]);
        this.wsManager.unsubscribeAddress(address);
        this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
        this.logger.log(`Cache cleared for address: ${address}`);
    }

    async clearAllCache() {
        try {
            // Clear all local cache data (addresses and tokens)
            await this.db.clear();
            // Cancel all WebSocket subscriptions (addresses and tokens)
            this.wsManager.unsubscribeAll();

            // Update cache status to UNKNOWN for each address
            this.statusMap.forEach((_, addr) => {
                this._setCacheStatus(addr, CACHE_STATUS.UNKNOWN);
            });
            // Update token cache status to UNKNOWN for each token
            this.tokenStatusMap.forEach((_, tokenId) => {
                this._setTokenCacheStatus(tokenId, CACHE_STATUS.UNKNOWN);
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
                const metadata = await this._getGlobalMetadata(address);
                const cachedCount = metadata ? metadata.numTxs : (cachedData ? cachedData.numTxs : 0);

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
                    // 使用单独的 (0,1) 请求来快速获取最新的 numTxs
                    const quickResult = await this._quickGetTxCount(address);
                    const apiNumTxs = quickResult;
                    this.logger.log(`[${address}] Quick API numTxs: ${apiNumTxs}`);

                    if (currentStatus !== CACHE_STATUS.UPDATING) {
                        this._checkAndUpdateCache(address, apiNumTxs, this.defaultPageSize);
                    }

                    // 如果用户请求的 pageSize 大于 200，返回提示信息
                    if (pageSize > 200) {
                        return {
                            message: "Cache is being prepared. Please wait for cache to be ready when requesting more than 200 transactions.",
                            numTxs: 0,
                            txs: [],
                            numPages: 0
                        };
                    }
                    
                    // 使用原始的用户请求参数获取所需数据
                    const apiResult = await this.chronik.address(address).history(pageOffset, apiPageSize);
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


    async _getPageFromCache(address, pageOffset, pageSize) {
        const cache = await this._readCache(address);
        if (!cache) return null;

        const metadata = await this._getGlobalMetadata(address);
        if (!metadata) return null;

        // Sort transaction order using the helper function.
        cache.txOrder = sortTxIds(cache.txOrder, key => cache.txMap[key]);

        // Compute new hash and check metadata...
        const newHash = computeHash(cache.txOrder);
        // Log new hash and stored hash values
        this.logger.log(`[${address}] newHash: ${newHash}, stored hash: ${metadata.dataHash}`);
        if (newHash !== metadata.dataHash) {
            this.logger.log(`[${address}] Cache order hash mismatch detected. Triggering cache update.`);
            this._checkAndUpdateCache(address, metadata.numTxs, this.defaultPageSize, true);
        }

        const start = pageOffset * pageSize;
        const end = start + pageSize;
        const txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        // Update unconfirmed transactions in the current page.
        this._updatePageUnconfirmedTxs(address, cache, txs);

        return {
            txs,
            numPages: Math.ceil(metadata.numTxs / pageSize),
            numTxs: metadata.numTxs
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

    async _checkAndUpdateTokenCache(tokenId, apiNumTxs, pageSize, forceUpdate = false) {
        // Check if number of transactions exceeds the memory limit
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
                let dynamicPageSize = pageSize;
                if (cachedData && typeof cachedData.numTxs === 'number') {
                    dynamicPageSize = apiNumTxs - cachedData.numTxs;
                    if (dynamicPageSize < 1) {
                        dynamicPageSize = 1;
                    }
                }
                if (dynamicPageSize > 200) {
                    dynamicPageSize = 200;
                }
                // 如果缓存不存在、交易数量不一致，或者强制更新（forceUpdate）为 true 时，则进行更新
                if (!cachedData || cachedData.numTxs !== apiNumTxs || forceUpdate) {
                    this.tokenUpdateLocks.set(tokenId, true);
                    this.updateQueue.enqueue(async () => {
                        try {
                            this.logger.log(`[Token ${tokenId}] Cache needs update${forceUpdate ? ' (forced update)' : ''}, dynamic page size: ${dynamicPageSize}`);
                            await this._updateTokenCache(tokenId, apiNumTxs, dynamicPageSize);
                        } finally {
                            this.tokenUpdateLocks.delete(tokenId);
                        }
                    });
                    this.logger.log(`[Token ${tokenId}] Current global update queue length: ${this.updateQueue.getQueueLength()}`);
                } else {
                    this.logger.log(`[Token ${tokenId}] Cache is up to date, setting status to LATEST`);
                    this._setTokenCacheStatus(tokenId, CACHE_STATUS.LATEST);
                    await this._initWebsocketForToken(tokenId);
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
                    this.logger.log(`[${tokenId}] Transaction count (${totalNumTxs}) exceeds maxMemory limit (${this.maxMemory}), aborting cache update.`);
                    this._setTokenCacheStatus(tokenId, CACHE_STATUS.UNKNOWN);
                    return;
                }

                this.logger.log(`[${tokenId}] Starting cache update.`);
                let currentPage = 0;
                let iterationCount = 0;
                let localCache = await this._readCache(tokenId) || { txMap: {}, txOrder: [] };
                let localTxMap = new Map(Object.entries(localCache.txMap));
                let localTxOrder = localCache.txOrder;
        
                while (true) {
                    const currentSize = localTxMap.size;
                    this.logger.log(`[${tokenId}] Updating cache page ${currentPage}, current size: ${currentSize}/${totalNumTxs}`);
        
                    if (currentSize >= totalNumTxs) {
                        // Re-sort the txOrder before final cache write
                        this.logger.startTimer(`[${tokenId}] Final sorting tx order`);
                        localTxOrder = sortTxIds(Array.from(localTxMap.keys()), key => localTxMap.get(key));
                        this.logger.endTimer(`[${tokenId}] Final sorting tx order`);
                        
                        // Always write the final state into the cache
                        this.logger.startTimer(`[${tokenId}] Final write cache`);
                        const updatedData = {
                            txMap: Object.fromEntries(localTxMap),
                            txOrder: localTxOrder,
                        };
                        await this._writeCache(tokenId, updatedData, true);
                        this.logger.endTimer(`[${tokenId}] Final write cache`);
                        
                        this.logger.log(`[${tokenId}] Cache update completed, final size: ${currentSize}`);
                        break;
                    }
        
                    this.logger.startTimer(`[${tokenId}] Fetch history`);
                    const result = await this.chronik.tokenId(tokenId).history(currentPage, pageSize);
                    this.logger.endTimer(`[${tokenId}] Fetch history`);
        
                    this.logger.startTimer(`[${tokenId}] Process tx`);
                    result.txs.forEach(tx => {
                        if (!localTxMap.has(tx.txid)) {
                            localTxMap.set(tx.txid, tx);
                        }
                    });
                    this.logger.endTimer(`[${tokenId}] Process tx`);
        
                    this.logger.startTimer(`[${tokenId}] Sorting tx order`);
                    localTxOrder = sortTxIds(Array.from(localTxMap.keys()), key => localTxMap.get(key));
                    this.logger.endTimer(`[${tokenId}] Sorting tx order`);
        
                    if (localTxMap.size >= 20000) {
                        if (iterationCount % 10 === 0) {
                            this.logger.startTimer(`[${tokenId}] Write cache`);
                            const updatedData = {
                                txMap: Object.fromEntries(localTxMap),
                                txOrder: localTxOrder,
                            };
                            await this._writeCache(tokenId, updatedData, true);
                            this.logger.endTimer(`[${tokenId}] Write cache`);
                        } else {
                            this.logger.log(`[${tokenId}] Skipping DB write to reduce overhead (iteration ${iterationCount}).`);
                        }
                    } else {
                        this.logger.startTimer(`[${tokenId}] Write cache`);
                        const updatedData = {
                            txMap: Object.fromEntries(localTxMap),
                            txOrder: localTxOrder,
                        };
                        await this._writeCache(tokenId, updatedData, true);
                        this.logger.endTimer(`[${tokenId}] Write cache`);
                    }
        
                    currentPage++;
                    iterationCount++;
                }
        
                // 主动释放内存
                this.logger.log(`[${tokenId}] Cleaning up memory used for cache update.`);
                localTxMap.clear();
                localTxOrder = null;
        
                const currentStatus = this._getTokenCacheStatus(tokenId);
                if (currentStatus !== CACHE_STATUS.LATEST) {
                    this.logger.log(`[${tokenId}] Cache update complete, setting status to LATEST.`);
                    this._setTokenCacheStatus(tokenId, CACHE_STATUS.LATEST);
        
                    await this._initWebsocketForToken(tokenId);
                } else {
                    this.logger.log(`[${tokenId}] Cache update complete, maintaining LATEST status.`);
                }
            } catch (error) {
                this.logger.error('[Cache] Error in _updateTokenCache:', error);
                throw error;
            }
        }, `updateTokenCache for ${tokenId}`);
    }

    async getTokenHistory(tokenId, pageOffset = 0, pageSize = 200) {
        this.logger.log('[DEBUG] getTokenHistory called with:', { tokenId, pageOffset, pageSize });
        const apiPageSize = Math.min(200, pageSize);
        const cachePageSize = Math.min(15000, pageSize);
        this.logger.log('[DEBUG] getTokenHistory - computed:', { apiPageSize, cachePageSize });
        return await this.failover.executeWithRetry(async () => {
            try {
                const currentStatus = this._getTokenCacheStatus(tokenId);
                const cachedData = await this._readCache(tokenId);
                const metadata = await this._getGlobalMetadata(tokenId, true);
                const cachedCount = metadata ? metadata.numTxs : (cachedData ? cachedData.numTxs : 0);
                this.logger.log(`[Token ${tokenId}] Cache status: ${currentStatus}, Cached txs: ${cachedCount}`);

                // 检查 WebSocket 定时器状态
                const wsTimeInfo = this.wsManager.getRemainingTime(tokenId);
                if (wsTimeInfo.active) {
                    this.logger.log(`[Token ${tokenId}] WebSocket remaining time: ${wsTimeInfo.remainingSec} seconds`);
                } else {
                    this.logger.log(`[Token ${tokenId}] ${wsTimeInfo.message}`);
                    if (currentStatus === CACHE_STATUS.LATEST) {
                        await this._initWebsocketForToken(tokenId);
                    }
                }

                if (currentStatus === CACHE_STATUS.LATEST) {
                    this.wsManager.resetWsTimer(tokenId);
                }

                if (currentStatus !== CACHE_STATUS.LATEST) {
                    const quickResult = await this._quickGetTxCount(tokenId, 'token');
                    const apiNumTxs = quickResult;
                    this.logger.log(`[Token ${tokenId}] Quick API numTxs: ${apiNumTxs}`);

                    if (currentStatus !== CACHE_STATUS.UPDATING) {
                        this._checkAndUpdateTokenCache(tokenId, apiNumTxs, this.defaultPageSize);
                    }

                    if (pageSize > 200) {
                        return {
                            message: "Cache is being prepared. Please wait for cache to be ready when requesting more than 200 transactions.",
                            numTxs: 0,
                            txs: [],
                            numPages: 0
                        };
                    }
                    
                    const apiResult = await this.chronik.tokenId(tokenId).history(pageOffset, apiPageSize);
                    return apiResult;
                }

                const cachedResult = await this._getTokenPageFromCache(tokenId, pageOffset, cachePageSize);
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

    // 新增快速获取交易数量的方法
    async _quickGetTxCount(identifier, type = 'address') {
        try {
            let result;
            if (type === 'address') {
                result = await this.chronik.address(identifier).history(0, 1);
            } else if (type === 'token') {
                result = await this.chronik.tokenId(identifier).history(0, 1);
            } else {
                throw new Error(`Unsupported type: ${type}`);
            }
            return result.numTxs;
        } catch (error) {
            this.logger.error('Error in _quickGetTxCount:', error);
            throw error;
        }
    }

    // For token cache clear, rely on dbUtils.clearTokenCache (see below)
    async clearTokenCache(tokenId) {
        await this.db.clearTokenCache(tokenId);
        if (typeof this.wsManager.unsubscribeToken === 'function') {
            this.wsManager.unsubscribeToken(tokenId);
        }
        this._setTokenCacheStatus(tokenId, CACHE_STATUS.UNKNOWN);
        this.logger.log(`Cache cleared for token: ${tokenId}`);
    }

    // 修改 _updateUnconfirmedTx 方法，使其接受 addressOrTokenId 参数
    async _updateUnconfirmedTx(addressOrTokenId, txid) {
        try {
            const updatedTx = await this.chronik.tx(txid);
            let cache = await this._readCache(addressOrTokenId);
            if (!cache || !cache.txMap) {
                this.logger.log(`[${addressOrTokenId}] Cache not found or empty when updating tx`);
                return;
            }
            if (cache.txMap[txid]) {
                cache.txMap[txid] = updatedTx;
                // 重新排序 txOrder（因为交易状态已更新）
                cache.txOrder = sortTxIds(Array.from(cache.txMap.keys()), key => cache.txMap[key]);
                // 异步更新缓存
                this._writeCache(addressOrTokenId, cache);
                this.logger.log(`[${addressOrTokenId}] Updated tx ${txid} in cache`);
            } else {
                this.logger.log(`[${addressOrTokenId}] Tx ${txid} not found in cache`);
            }
        } catch (error) {
            this.logger.error(`Error updating tx ${txid} in cache:`, error);
        }
    }

    // 修改后的 _updatePageUnconfirmedTxs 方法
    async _updatePageUnconfirmedTxs(address, cache, txsInCurrentPage) {
        // Correct mistaken unconfirmed transactions based on block.height.
        const mistakenTxs = txsInCurrentPage.filter(tx => !tx.isFinal && tx.block && tx.block.height);
        let updated = false;
        mistakenTxs.forEach(tx => {
            cache.txMap[tx.txid].isFinal = true;
            this.logger.log(`[${address}] Corrected tx ${tx.txid} isFinal to true based on block.height`);
            updated = true;
        });
    
        // Process remaining unconfirmed transactions.
        const unconfirmedTxids = txsInCurrentPage
            .filter(tx => !tx.isFinal && (!tx.block || !tx.block.height))
            .map(tx => tx.txid);
    
        for (const txid of unconfirmedTxids) {
            try {
                const updatedTx = await this.chronik.tx(txid);
                if (updatedTx && updatedTx.isFinal) {
                    cache.txMap[txid] = updatedTx;
                    this.logger.log(`[${address}] Updated tx ${txid} in cache`);
                    updated = true;
                } else {
                    this.logger.log(`[${address}] Tx ${txid} is still unconfirmed, skipping update`);
                }
            } catch (error) {
                this.logger.error(`Error updating tx ${txid} in cache:`, error);
            }
        }
    
        // If any transaction updated, resort and write back cache.
        if (updated) {
            cache.txOrder = sortTxIds(cache.txOrder, key => cache.txMap[key]);
            await this._writeCache(address, cache);
        }
    }

    // 修改后的 _updatePageUnconfirmedTokenTxs 方法
    async _updatePageUnconfirmedTokenTxs(tokenId, cache, txsInCurrentPage) {
        // First, update mistakenly unconfirmed transactions that actually have block.height.
        const mistakenTxs = txsInCurrentPage.filter(tx => !tx.isFinal && tx.block && tx.block.height);
        let updated = false;
        mistakenTxs.forEach(tx => {
            // Correct the isFinal flag in cache since block data exists.
            cache.txMap[tx.txid].isFinal = true;
            this.logger.log(`[${tokenId}] Corrected tx ${tx.txid} isFinal to true based on block.height`);
            updated = true;
        });

        // Then, process the remaining transactions which are still unconfirmed (and lack block.height).
        const unconfirmedTxids = txsInCurrentPage
            .filter(tx => !tx.isFinal && (!tx.block || !tx.block.height))
            .map(tx => tx.txid);

        for (const txid of unconfirmedTxids) {
            try {
                const updatedTx = await this.chronik.tx(txid);
                if (updatedTx && updatedTx.isFinal) {
                    cache.txMap[txid] = updatedTx;
                    this.logger.log(`[${tokenId}] Updated tx ${txid} in cache`);
                    updated = true;
                } else {
                    this.logger.log(`[${tokenId}] Tx ${txid} is still unconfirmed, skipping update`);
                }
            } catch (error) {
                this.logger.error(`Error updating tx ${txid} in cache:`, error);
            }
        }

        // If any transaction was updated, re-sort the cache and write it back.
        if (updated) {
            cache.txOrder = sortTxIds(cache.txOrder, key => cache.txMap[key]);
            await this._writeCache(tokenId, cache);
        }
    }

    // 修改 token 的 getPageFromCache 方法
    async _getTokenPageFromCache(tokenId, pageOffset, pageSize) {
        const cache = await this._readCache(tokenId);
        if (!cache) return null;

        const metadata = await this._getGlobalMetadata(tokenId, true);
        if (!metadata) return null;

        // Sort transaction order using the helper function.
        cache.txOrder = sortTxIds(cache.txOrder, key => cache.txMap[key]);

        // Compute new hash and check metadata...
        const newHash = computeHash(cache.txOrder);
        // Log new hash and stored hash values
        this.logger.log(`[${tokenId}] newHash: ${newHash}, stored hash: ${metadata.dataHash}`);
        if (newHash !== metadata.dataHash) {
            this.logger.log(`[${tokenId}] Token cache order hash mismatch detected. Forcing cache update.`);
            this._checkAndUpdateTokenCache(tokenId, metadata.numTxs, this.defaultPageSize, true);
        }

        const start = pageOffset * pageSize;
        const end = start + pageSize;
        const txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        // Update unconfirmed transactions in the current page.
        this._updatePageUnconfirmedTokenTxs(tokenId, cache, txs);

        return {
            txs,
            numPages: Math.ceil(metadata.numTxs / pageSize),
            numTxs: metadata.numTxs
        };
    }

    _maintainGlobalMetadataCacheLimit() {
        while (this.globalMetadataCache.size > this.globalMetadataCacheLimit) {
            const oldestKey = this.globalMetadataCache.keys().next().value;
            this.globalMetadataCache.delete(oldestKey);
            this.logger.log(`Evicted globalMetadataCache entry for key ${oldestKey}`);
        }
    }

    // 新增公共方法 getCacheStatus, 方便用户直接查询缓存状态
    getCacheStatus(identifier, isToken = false) {
        if (isToken) {
            return this._getTokenCacheStatus(identifier);
        }
        return this._getCacheStatus(identifier);
    }
}

module.exports = ChronikCache; 