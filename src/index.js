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
const CacheStats = require('./lib/CacheStats');


class ChronikCache {
    constructor(chronik, {
        maxTxLimit = DEFAULT_CONFIG.MAX_TX_LIMIT,
        maxCacheSize = DEFAULT_CONFIG.MAX_CACHE_SIZE,
        failoverOptions = {},
        enableLogging = true,
        enableTimer = false,
        wsTimeout = DEFAULT_CONFIG.WS_TIMEOUT,
        wsExtendTimeout = DEFAULT_CONFIG.WS_EXTEND_TIMEOUT
    } = {}) {
        this.chronik = chronik;
        this.maxTxLimit = maxTxLimit;
        this.defaultPageSize = DEFAULT_CONFIG.DEFAULT_PAGE_SIZE;
        this.cacheDir = DEFAULT_CONFIG.CACHE_DIR;
        this.maxCacheSize = maxCacheSize * 1024 * 1024;  
        this.enableLogging = enableLogging;

        this.logger = new Logger(enableLogging, enableTimer);

        // Initialize database utilities
        this.db = new DbUtils(this.cacheDir, {
            valueEncoding: 'json',
            maxCacheSize: this.maxCacheSize,
            enableLogging
        });

        this.statusMap = new Map();
        // Pass onEvict callback to update cache status to UNKNOWN
        this.wsManager = new WebSocketManager(chronik, failoverOptions, enableLogging, {
            wsTimeout,
            wsExtendTimeout,
            onEvict: (identifier, subscriptionType) => {
                const isToken = subscriptionType === 'token';
                this._setCacheStatus(identifier, CACHE_STATUS.UNKNOWN, isToken);
            }
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
        // 初始化交易更新队列，最大并发 5 个
        this.txUpdateQueue = new TaskQueue(5);
        
        // =========================================================
        // NEW: In-memory cache to hold the entire persistent cache
        this.addressMemoryCache = new Map();
        this.tokenMemoryCache = new Map();
        // =========================================================
        
        // Initialize stats
        this.stats = new CacheStats(this, this.logger);

        // 在内存缓存中，为每个条目都维护一个独立的过期时间（初始120秒）。
        // 每访问一次该条目，就将过期时间增加10秒。
        // 后台定时检查过期条目，将其移除。
        this._startMemoryCacheExpirationCheckTimer();

        return new Proxy(this, {
            get: (target, prop) => {
                // If the property exists on ChronikCache object, return directly
                if (prop in target) {
                    return target[prop];
                }
                // If the underlying chronik has the function, wrap it to add status: 3 to the result
                if (typeof chronik[prop] === 'function') {
                    return (...args) => {
                        this.logger.log(`Forwarding uncached method call: ${prop}`);
                        return Promise.resolve(chronik[prop](...args)).then(result => {
                            if (typeof result === 'object' && result !== null) {
                                return { ...result, status: 3 };
                            }
                            return result;
                        });
                    };
                }
                // If the underlying chronik has this property, return it
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
        try {
            return await this.failover.handleWebSocketOperation(async () => {
                this.wsManager.resetWsTimer(address, (addr) => {
                    // Set status to UNKNOWN on websocket reset
                    this._setCacheStatus(addr, CACHE_STATUS.UNKNOWN);
                    // Clear in-memory cache
                    this._resetMemoryCache(addr, false);
                });

                await this.wsManager.initWebsocketForAddress(address, async (addr, txid, msgType) => {
                    if (msgType === 'TX_ADDED_TO_MEMPOOL') {
                        const apiNumTxs = await this._quickGetTxCount(addr, 'address');
                        this._resetMemoryCache(addr, false);
                        await this._updateCache(addr, apiNumTxs, this.defaultPageSize);
                    } else if (msgType === 'TX_FINALIZED') {
                        this._resetMemoryCache(addr, false);
                        await this._updateUnconfirmedTx(addr, txid);
                    }
                });
            }, address, 'WebSocket initialization');
        } catch (error) {
            this.logger.error('Error in websocket initialization, falling back to UNKNOWN status', error);
            this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
        }
    }

    async _initWebsocketForToken(tokenId) {
        try {
            return await this.failover.handleWebSocketOperation(async () => {
                this.wsManager.resetWsTimer(tokenId, (id) => {
                    // Set status to UNKNOWN for token on websocket reset
                    this._setCacheStatus(id, CACHE_STATUS.UNKNOWN, true);
                    // Clear in-memory cache for token
                    this._resetMemoryCache(id, true);
                });

                await this.wsManager.initWebsocketForToken(tokenId, async (id, txid, msgType) => {
                    if (msgType === 'TX_ADDED_TO_MEMPOOL') {
                        const apiNumTxs = await this._quickGetTxCount(id, 'token');
                        this._resetMemoryCache(id, true);
                        await this._updateTokenCache(id, apiNumTxs, this.defaultPageSize);
                    } else if (msgType === 'TX_FINALIZED') {
                        this._resetMemoryCache(id, true);
                        await this._updateUnconfirmedTx(id, txid);
                    }
                });
            }, tokenId, 'WebSocket initialization');
        } catch (error) {
            this.logger.error('Error in websocket initialization for token, falling back to UNKNOWN status', error);
            this._setCacheStatus(tokenId, CACHE_STATUS.UNKNOWN, true);
        }
    }

    /* --------------------- 缓存状态管理方法 --------------------- */

    _getCacheStatus(identifier, isToken = false) {
        const isUpdating = this._isUpdating(identifier, isToken);
        if (isUpdating) {
            return CACHE_STATUS.UPDATING;
        }

        const statusMap = isToken ? this.tokenStatusMap : this.statusMap;
        const status = statusMap.get(identifier);
        return status?.status ?? CACHE_STATUS.UNKNOWN;
    }

    _setCacheStatus(identifier, status, isToken = false) {
        const now = Date.now();
        const targetMap = isToken ? this.tokenStatusMap : this.statusMap;
        const existingStatus = targetMap.get(identifier);
        
        // 添加详细的状态变化日志
        this.logger.log(`[${isToken ? 'Token' : 'Address'} ${identifier}] 
            Attempting to change status from ${existingStatus?.status} to ${status}
            Current update lock: ${this._isUpdating(identifier, isToken)}
        `);
        
        targetMap.set(identifier, {
            status,
            cacheTimestamp: existingStatus?.cacheTimestamp || now
        });
    }

    /* --------------------- Core Cache Update Logic --------------------- */

    _isUpdating(identifier, isToken = false) {
        const updateMap = isToken ? this.tokenUpdateLocks : this.updateLocks;
        return updateMap.has(identifier);
    }

    // 修改检查限制的方法名和实现
    _checkTxLimit(identifier, numTxs, isToken = false) {
        if (numTxs > this.maxTxLimit) {
            const idType = isToken ? 'Token' : 'Address';
            this.logger.log(`[${idType} ${identifier}] Transaction count (${numTxs}) exceeds maxTxLimit (${this.maxTxLimit}), setting to REJECT status`);
            this._setCacheStatus(identifier, CACHE_STATUS.REJECT, isToken);
            return true;
        }
        return false;
    }

    async _checkAndUpdateCache(address, apiNumTxs, pageSize, forceUpdate = false) {
        if (this._checkTxLimit(address, apiNumTxs)) {
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
                    this._initWebsocketForAddress(address);
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
                if (this._checkTxLimit(address, totalNumTxs)) {
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
                      //  this.logger.startTimer(`[${address}] Final sorting tx order`);
                        localTxOrder = sortTxIds(Array.from(localTxMap.keys()), key => localTxMap.get(key));
                    //    this.logger.endTimer(`[${address}] Final sorting tx order`);

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
            
                  //  this.logger.startTimer(`[${address}] Process tx`);
                    result.txs.forEach(tx => {
                        if (!localTxMap.has(tx.txid)) {
                            localTxMap.set(tx.txid, tx);
                        }
                    });
                 //   this.logger.endTimer(`[${address}] Process tx`);
            
                //    this.logger.startTimer(`[${address}] Sorting tx order`);
                    // Use helper function to sort txOrder
                    localTxOrder = sortTxIds(Array.from(localTxMap.keys()), key => localTxMap.get(key));
                //    this.logger.endTimer(`[${address}] Sorting tx order`);
            
                    if (localTxMap.size >= 2000) {
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
            //    this.logger.log(`[${address}] Cleaning up memory used for cache update.`);
                localTxMap.clear();
                localTxOrder = null;
            
                const currentStatus = this._getCacheStatus(address);
                if (currentStatus !== CACHE_STATUS.LATEST) {
                    this.logger.log(`[${address}] Cache update complete, setting status to LATEST.`);
                    this._setCacheStatus(address, CACHE_STATUS.LATEST);
                    this._initWebsocketForAddress(address);
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
                this._setCacheStatus(tokenId, CACHE_STATUS.UNKNOWN, true);
            });
            this.logger.log('All cache cleared successfully');
        } catch (error) {
            this.logger.error('Error clearing all cache:', error);
        }
    }

    async getAddressHistory(address, pageOffset = 0, pageSize = 200) {
        return await this.failover.executeWithRetry(async () => {
            try {
                const currentStatus = this._getCacheStatus(address);
                
                // If the cache is rejected, use chronik directly and add status: 2
                if (currentStatus === CACHE_STATUS.REJECT) {
                    const result = await this.chronik.address(address).history(pageOffset, Math.min(200, pageSize));
                    return {
                        ...result,
                        message: "Transaction count exceeds cache limit, serving directly from Chronik API",
                        status: 2
                    };
                }
                
                const apiPageSize = Math.min(200, pageSize);
                const cachePageSize = Math.min(4000, pageSize);

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
                        this._initWebsocketForAddress(address);
                    }
                }

                if (currentStatus === CACHE_STATUS.LATEST) {
                    this.wsManager.resetWsTimer(address);
                }

                if (currentStatus !== CACHE_STATUS.LATEST) {
                    // Call quick API to get the latest tx count
                    const quickResult = await this._quickGetTxCount(address);
                    const apiNumTxs = quickResult;
                    this.logger.log(`[${address}] Quick API numTxs: ${apiNumTxs}`);

                    if (currentStatus !== CACHE_STATUS.UPDATING) {
                        this._checkAndUpdateCache(address, apiNumTxs, this.defaultPageSize);
                    }

                    // If user requests pageSize greater than 200, prompt with "cache is being prepared" (status: 1)
                    if (pageSize > 200) {
                        return {
                            status: 1,
                            message: "Cache is being prepared. Please wait for cache to be ready when requesting more than 200 transactions.",
                            numTxs: 0,
                            txs: [],
                            numPages: 0
                        };
                    }
                    
                    // Fallback: use chronik API directly and attach status: 3
                    const apiResult = await this.chronik.address(address).history(pageOffset, apiPageSize);
                    return { ...apiResult, status: 3 };
                }

                const cachedResult = await this._getPageFromCache(address, pageOffset, cachePageSize);
                if (cachedResult) {
                    return cachedResult;
                }
                const apiFallback = await this.chronik.address(address).history(pageOffset, apiPageSize);
                this.logger.log(`[${address}] API txs count (fallback): ${apiFallback.numTxs}`);
                return { ...apiFallback, status: 3 };
            } catch (error) {
                this.logger.error('[Cache] Error in getAddressHistory:', error);
                throw error;
            }
        }, `getAddressHistory for ${address}`);
    }


    async _getPageFromCache(address, pageOffset, pageSize) {
        this.logger.startTimer(`[${address}] _getPageFromCache`);
        let cacheEntry = this.addressMemoryCache.get(address);
        const now = Date.now();

        if (cacheEntry) {
            // 如果已过期，则从内存中移除，返回 null
            if (now > cacheEntry.expiry) {
                this.logger.log(`[${address}] In-memory cache entry expired`);
                this.addressMemoryCache.delete(address);
                cacheEntry = null;
            } else {
                // 未过期，延长该条目的过期时间10秒
                cacheEntry.expiry += 10 * 1000;
                this.logger.log(`[${address}] In-memory cache hit, extending expiry by 10 seconds`);
            }
        }

        let cache;
        if (cacheEntry) {
            cache = cacheEntry.data;
        } else {
            this.logger.startTimer(`[${address}] Read persistent cache from DB`);
            cache = await this._readCache(address);
            this.logger.endTimer(`[${address}] Read persistent cache from DB`);
            if (!cache) return null;
            // 初次放入内存：设定初始过期时间为120秒
            this.addressMemoryCache.set(address, {
                data: cache,
                expiry: now + 120 * 1000
            });
        }

        const metadata = await this._getGlobalMetadata(address);
        if (!metadata) return null;

        // 保证 txOrder 排序
        cache.txOrder = sortTxIds(cache.txOrder, key => cache.txMap[key]);

        // With 50% probability, compute hash and check consistency
        if (Math.random() < 0.5) {
            const newHash = computeHash(cache.txOrder);
            this.logger.log(`[${address}] newHash: ${newHash}, stored hash: ${metadata.dataHash}`);
            if (newHash !== metadata.dataHash) {
                this.logger.log(`[${address}] Cache order hash mismatch detected. Triggering cache update and invalidating in-memory cache.`);
                this._checkAndUpdateCache(address, metadata.numTxs, this.defaultPageSize, true);
                // Invalidate the in-memory cache since data is stale
                this._resetMemoryCache(address, false);
            }
        } else {
            this.logger.log(`[${address}] Skipped hash computation check.`);
        }

        const start = pageOffset * pageSize;
        const end = start + pageSize;
        const txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        await this._updatePageUnconfirmedTxs(address, cache, txs, false);

        this.logger.endTimer(`[${address}] _getPageFromCache`);
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


    async _checkAndUpdateTokenCache(tokenId, apiNumTxs, pageSize, forceUpdate = false) {
        if (this._checkTxLimit(tokenId, apiNumTxs, true)) {
            return;
        }

        if (this._isUpdating(tokenId, true)) {
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
                    this._setCacheStatus(tokenId, CACHE_STATUS.LATEST, true);

                    // 异步触发 WS 初始化，避免阻塞更新锁的释放
                    this._initWebsocketForToken(tokenId).catch(err => this.logger.error(err));
                }
            } catch (error) {
                this.logger.error('Token cache update error:', error);
                this.logger.log(`[Token ${tokenId}] Error occurred, setting status to UNKNOWN`);
                this._setCacheStatus(tokenId, CACHE_STATUS.UNKNOWN, true);
            }
        });
    }

    async _updateTokenCache(tokenId, totalNumTxs, pageSize) {
        return await this.failover.executeWithRetry(async () => {
            try {
                if (this._checkTxLimit(tokenId, totalNumTxs, true)) {
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
                      //  this.logger.startTimer(`[${tokenId}] Final sorting tx order`);
                        localTxOrder = sortTxIds(Array.from(localTxMap.keys()), key => localTxMap.get(key));
                  //      this.logger.endTimer(`[${tokenId}] Final sorting tx order`);
                        
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
        
                //    this.logger.startTimer(`[${tokenId}] Process tx`);
                    result.txs.forEach(tx => {
                        if (!localTxMap.has(tx.txid)) {
                            localTxMap.set(tx.txid, tx);
                        }
                    });
              //      this.logger.endTimer(`[${tokenId}] Process tx`);
        
               //     this.logger.startTimer(`[${tokenId}] Sorting tx order`);
                    localTxOrder = sortTxIds(Array.from(localTxMap.keys()), key => localTxMap.get(key));
               //     this.logger.endTimer(`[${tokenId}] Sorting tx order`);
        
                    if (localTxMap.size >= 2000) {
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
               // this.logger.log(`[${tokenId}] Cleaning up memory used for cache update.`);
                localTxMap.clear();
                localTxOrder = null;
        
                const currentStatus = this._getCacheStatus(tokenId, true);
                if (currentStatus !== CACHE_STATUS.LATEST) {
                    this.logger.log(`[${tokenId}] Cache update complete, setting status to LATEST.`);
                    this._setCacheStatus(tokenId, CACHE_STATUS.LATEST, true);
        
                    // 异步触发 WS 初始化，避免阻塞更新锁的释放
                    this._initWebsocketForToken(tokenId).catch(err => this.logger.error(err));
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
      // this.logger.log('[DEBUG] getTokenHistory called with:', { tokenId, pageOffset, pageSize });
        const apiPageSize = Math.min(200, pageSize);
        const cachePageSize = Math.min(15000, pageSize);
       // this.logger.log('[DEBUG] getTokenHistory - computed:', { apiPageSize, cachePageSize });
        return await this.failover.executeWithRetry(async () => {
            try {
                const currentStatus = this._getCacheStatus(tokenId, true);
                
                // If the cache is rejected, use chronik directly and add status: 2
                if (currentStatus === CACHE_STATUS.REJECT) {
                    const result = await this.chronik.tokenId(tokenId).history(pageOffset, Math.min(200, pageSize));
                    return {
                        ...result,
                        message: "Transaction count exceeds cache limit, serving directly from Chronik API",
                        status: 2
                    };
                }
                
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
                        this._initWebsocketForToken(tokenId).catch(err => this.logger.error(err));
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
                            status: 1,
                            message: "Cache is being prepared. Please wait for cache to be ready when requesting more than 200 transactions.",
                            numTxs: 0,
                            txs: [],
                            numPages: 0
                        };
                    }
                    
                    const apiResult = await this.chronik.tokenId(tokenId).history(pageOffset, apiPageSize);
                    return { ...apiResult, status: 3 };
                }

                const cachedResult = await this._getTokenPageFromCache(tokenId, pageOffset, cachePageSize);
                if (cachedResult) {
                    return cachedResult;
                }
                const apiFallback = await this.chronik.tokenId(tokenId).history(pageOffset, apiPageSize);
                this.logger.log(`[Token ${tokenId}] API txs count (fallback): ${apiFallback.numTxs}`);
                return { ...apiFallback, status: 3 };
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
        this._setCacheStatus(tokenId, CACHE_STATUS.UNKNOWN, true);
        this.logger.log(`Cache cleared for token: ${tokenId}`);
    }

    // 修改 _updateUnconfirmedTx 方法，使其接受 addressOrTokenId 参数
    async _updateUnconfirmedTx(addressOrTokenId, txid) {
        return this.txUpdateQueue.enqueue(async () => {
            try {
                const updatedTx = await this.chronik.tx(txid);
                let cache = await this._readCache(addressOrTokenId);
                if (!cache || !cache.txMap) {
                    this.logger.log(`[${addressOrTokenId}] Cache not found or empty when updating tx`);
                    return;
                }
                if (cache.txMap[txid]) {
                    cache.txMap[txid] = updatedTx;
                    cache.txOrder = sortTxIds(cache.txOrder, key => cache.txMap[key]);
                    await this._writeCache(addressOrTokenId, cache);
                    this.logger.log(`[${addressOrTokenId}] Updated tx ${txid} in cache`);
                }
            } catch (error) {
                this.logger.error(`Error updating tx ${txid} in cache:`, error);
                throw error;
            }
        });
    }

    // 合并后的通用方法
    async _updatePageUnconfirmedTxs(identifier, cache, txsInCurrentPage, isToken = false) {
        const idType = isToken ? 'token' : 'address';
        const mistakenTxs = txsInCurrentPage.filter(tx => !tx.isFinal && tx.block && tx.block.height);
        let updated = false;
        
        mistakenTxs.forEach(tx => {
            cache.txMap[tx.txid].isFinal = true;
            this.logger.log(`[${idType} ${identifier}] Corrected tx ${tx.txid} isFinal to true based on block.height`);
            updated = true;
        });

        const unconfirmedTxids = txsInCurrentPage
            .filter(tx => !tx.isFinal && (!tx.block || !tx.block.height))
            .map(tx => tx.txid);

        // 使用 Promise.all 和任务队列处理所有未确认交易
        await Promise.all(unconfirmedTxids.map(txid => 
            this.txUpdateQueue.enqueue(async () => {
                try {
                    const updatedTx = await this.chronik.tx(txid);
                    if (updatedTx && updatedTx.isFinal) {
                        cache.txMap[txid] = updatedTx;
                        updated = true;
                    }
                } catch (error) {
                    this.logger.error(`Error updating tx ${txid} in cache:`, error);
                }
            })
        )).then(() => {
            if (updated) {
                this.logger.log(`[${idType} ${identifier}] Updated some unconfirmed transactions`);
            }
        });

        if (updated) {
            cache.txOrder = sortTxIds(cache.txOrder, key => cache.txMap[key]);
            await this._writeCache(identifier, cache, isToken);
        }
    }

    // 修改 token 的 getPageFromCache 方法
    async _getTokenPageFromCache(tokenId, pageOffset, pageSize) {
        this.logger.startTimer(`[${tokenId}] _getTokenPageFromCache`);
        let cacheEntry = this.tokenMemoryCache.get(tokenId);
        const now = Date.now();

        if (cacheEntry) {
            if (now > cacheEntry.expiry) {
                this.logger.log(`[${tokenId}] In-memory token cache entry expired`);
                this.tokenMemoryCache.delete(tokenId);
                cacheEntry = null;
            } else {
                // 每次访问延长该条目的过期时间10秒
                cacheEntry.expiry += 10 * 1000;
                this.logger.log(`[${tokenId}] In-memory token cache hit, extending expiry by 10 seconds`);
            }
        }

        let cache;
        if (cacheEntry) {
            cache = cacheEntry.data;
        } else {
            this.logger.startTimer(`[${tokenId}] Read persistent cache from DB`);
            cache = await this._readCache(tokenId);
            this.logger.endTimer(`[${tokenId}] Read persistent cache from DB`);
            if (!cache) return null;
            // 初次放入内存：设定初始过期时间为120秒
            this.tokenMemoryCache.set(tokenId, {
                data: cache,
                expiry: now + 120 * 1000
            });
        }

        const metadata = await this._getGlobalMetadata(tokenId, true);
        if (!metadata) return null;

        cache.txOrder = sortTxIds(cache.txOrder, key => cache.txMap[key]);

        // With 50% probability, compute hash and check consistency
        if (Math.random() < 0.5) {
            const newHash = computeHash(cache.txOrder);
            this.logger.log(`[${tokenId}] newHash: ${newHash}, stored hash: ${metadata.dataHash}`);
            if (newHash !== metadata.dataHash) {
                this.logger.log(`[${tokenId}] Token cache order hash mismatch detected. Forcing cache update and invalidating in-memory cache.`);
                this._checkAndUpdateTokenCache(tokenId, metadata.numTxs, this.defaultPageSize, true);
                // Invalidate the in-memory cache since data is stale
                this._resetMemoryCache(tokenId, true);
            }
        } else {
            this.logger.log(`[${tokenId}] Skipped hash computation check.`);
        }

        const start = pageOffset * pageSize;
        const end = start + pageSize;
        const txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        await this._updatePageUnconfirmedTxs(tokenId, cache, txs, true);

        this.logger.endTimer(`[${tokenId}] _getTokenPageFromCache`);
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
            return this._getCacheStatus(identifier, true);
        }
        return this._getCacheStatus(identifier);
    }

    // Add a method to get statistics
    async getStatistics() {
        return await this.stats.getStatistics();
    }

    _resetMemoryCache(identifier, isToken = false) {
        // Clear the in-memory cache for the given identifier
        if (isToken) {
            this.tokenMemoryCache.delete(identifier);
        } else {
            this.addressMemoryCache.delete(identifier);
        }
    }

    // 在内存缓存中，为每个条目都维护一个独立的过期时间（初始120秒）。
    // 每访问一次该条目，就将过期时间增加10秒。
    // 后台定时检查过期条目，将其移除。
    _startMemoryCacheExpirationCheckTimer() {
        // 每隔10秒检查一次是否有过期条目
        const checkInterval = 10 * 1000;
        setTimeout(() => {
            const now = Date.now();

            // 检查 addressMemoryCache
            for (const [key, entry] of this.addressMemoryCache.entries()) {
                if (now > entry.expiry) {
                    // 过期则删除
                    this.addressMemoryCache.delete(key);
                }
            }

            // 检查 tokenMemoryCache
            for (const [key, entry] of this.tokenMemoryCache.entries()) {
                if (now > entry.expiry) {
                    this.tokenMemoryCache.delete(key);
                }
            }

            this._startMemoryCacheExpirationCheckTimer();
        }, checkInterval);
    }
}

module.exports = ChronikCache; 