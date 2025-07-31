// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

import DbUtils from './lib/dbUtils';
import WebSocketManager from './lib/WebSocketManager';
import Logger from './lib/Logger';
import { encodeCashAddress } from 'ecashaddrjs';
import { CACHE_STATUS, DEFAULT_CONFIG } from './constants';
import FailoverHandler from './lib/failover';
import { computeHash } from './lib/hash';
import TaskQueue from './lib/TaskQueue';
import sortTxIds from './lib/sortTxIds';
import CacheStats from './lib/CacheStats';

import {
    ChronikCacheConfig,
    Transaction,
    HistoryResponse,
    CacheData,
    CacheMetadata,
    CacheStatusInfo,
    WebSocketMessageType,
    CacheStatistics,
    ChronikClientInterface,
    MemoryCacheEntry
} from './types';

const MAX_ITEMS_PER_KEY = DEFAULT_CONFIG.MAX_ITEMS_PER_KEY;

class ChronikCache {
    private chronik: ChronikClientInterface;
    private maxTxLimit: number;
    private defaultPageSize: number;
    private cacheDir: string;
    private maxCacheSize: number;
    private enableLogging: boolean;
    private logger: any;
    public db: any;
    private statusMap: Map<string, CacheStatusInfo>;
    public wsManager: any;
    private updateLocks: Map<string, boolean>;
    private scriptToAddressMap: Map<string, string>;
    private failover: any;
    private tokenStatusMap: Map<string, CacheStatusInfo>;
    private tokenUpdateLocks: Map<string, boolean>;
    public globalMetadataCache: Map<string, CacheMetadata>;
    public globalMetadataCacheLimit: number;
    public updateQueue: any;
    public txUpdateQueue: any;
    private addressMemoryCache: Map<string, MemoryCacheEntry<CacheData>>;
    private tokenMemoryCache: Map<string, MemoryCacheEntry<CacheData>>;
    private stats: any;
    private debounceTimers: Map<string, NodeJS.Timeout>;
    private memoryCacheCleanupInterval?: NodeJS.Timeout;

    constructor(chronik: ChronikClientInterface, config: ChronikCacheConfig = {}) {
        const {
            maxTxLimit = DEFAULT_CONFIG.MAX_TX_LIMIT,
            maxCacheSize = DEFAULT_CONFIG.MAX_CACHE_SIZE,
            failoverOptions = {},
            enableLogging = true,
            enableTimer = false,
            wsTimeout = DEFAULT_CONFIG.WS_TIMEOUT,
            wsExtendTimeout = DEFAULT_CONFIG.WS_EXTEND_TIMEOUT
        } = config;

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

        this.statusMap = new Map<string, CacheStatusInfo>();
        // Pass onEvict callback to update cache status to UNKNOWN
        this.wsManager = new WebSocketManager(chronik, failoverOptions, enableLogging, {
            wsTimeout: wsTimeout as any,
            wsExtendTimeout: wsExtendTimeout as any,
            onEvict: (identifier: string, subscriptionType: string) => {
                const isToken = subscriptionType === 'token';
                this._setCacheStatus(identifier, CACHE_STATUS.UNKNOWN, isToken);
            }
        });
        this.updateLocks = new Map<string, boolean>();
        // Add script type to address cache mapping
        this.scriptToAddressMap = new Map<string, string>();
        // Add failover handler
        this.failover = new FailoverHandler(failoverOptions);
        // 添加token缓存相关的Map
        this.tokenStatusMap = new Map<string, CacheStatusInfo>();
        this.tokenUpdateLocks = new Map<string, boolean>();
        // 初始化全局元数据缓存，防止频繁访问数据库
        this.globalMetadataCache = new Map<string, CacheMetadata>();
        // Set LRU cache limit for global metadata cache
        this.globalMetadataCacheLimit = DEFAULT_CONFIG.GLOBAL_METADATA_CACHE_LIMIT || 100;
        // 初始化全局任务队列，最大并发 2 个
        this.updateQueue = new TaskQueue(2);
        // 初始化交易更新队列，最大并发 5 个
        this.txUpdateQueue = new TaskQueue(5);
        
        // =========================================================
        // NEW: In-memory cache to hold the entire persistent cache
        this.addressMemoryCache = new Map<string, MemoryCacheEntry<CacheData>>();
        this.tokenMemoryCache = new Map<string, MemoryCacheEntry<CacheData>>();
        // =========================================================
        
        // Initialize stats
        this.stats = new CacheStats(this, this.logger);

        // 启动内存缓存过期检查定时器
        this._startMemoryCacheExpirationCheckTimer();

        // 添加防抖计时器Map
        this.debounceTimers = new Map<string, NodeJS.Timeout>();

        return new Proxy(this, {
            get: (target: any, prop: string | symbol) => {
                // If the property exists on ChronikCache object, return directly
                if (prop in target) {
                    return target[prop];
                }
                // If the underlying chronik has the function, wrap it to add status: 3 to the result
                if (typeof (chronik as any)[prop] === 'function') {
                    return (...args: any[]) => {
                        this.logger.log(`Forwarding uncached method call: ${String(prop)}`);
                        return Promise.resolve((chronik as any)[prop](...args)).then((result: any) => {
                            if (typeof result === 'object' && result !== null) {
                                return { ...result, status: 3 };
                            }
                            return result;
                        });
                    };
                }
                // If the underlying chronik has this property, return it
                if (prop in chronik) {
                    return (chronik as any)[prop];
                }
                return undefined;
            }
        });
    }

    // 添加防抖工具方法
    private _debounce(key: string, fn: () => Promise<void>, delay: number = 500): void {
        if (this.debounceTimers.has(key)) {
            clearTimeout(this.debounceTimers.get(key)!);
        }
        
        const timer = setTimeout(async () => {
            this.debounceTimers.delete(key);
            try {
                await fn();
            } catch (error) {
                this.logger.error(`Error in debounced function for ${key}:`, error);
            }
        }, delay);
        
        this.debounceTimers.set(key, timer);
    }

    // Read cache from database by reading txMap and txOrder separately
    private async _readCache(addressOrTokenId: string): Promise<CacheData | null> {
        try {
            let txOrder: string[];
            let txMap: Record<string, Transaction>;

            // Check for paginated txOrder
            const txOrderMeta = await this.db.get(`${addressOrTokenId}:txOrder:meta`);
            if (txOrderMeta) {
                const { pageCount } = txOrderMeta;
                txOrder = [];
                for (let i = 0; i < pageCount; i++) {
                    const chunk = await this.db.get(`${addressOrTokenId}:txOrder:${i}`);
                    txOrder = txOrder.concat(chunk);
                }
            } else {
                txOrder = await this.db.get(`${addressOrTokenId}:txOrder`);
            }
            if (!txOrder) return null;

            // Check for paginated txMap
            const txMapMeta = await this.db.get(`${addressOrTokenId}:txMap:meta`);
            if (txMapMeta) {
                const { pageCount } = txMapMeta;
                txMap = {};
                for (let i = 0; i < pageCount; i++) {
                    const chunk = await this.db.get(`${addressOrTokenId}:txMap:${i}`);
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
        } catch {
            return null;
        }
    }
    
    // Write cache into database with pagination support if tx count exceeds MAX_ITEMS_PER_KEY
    private async _writeCache(addressOrTokenId: string, data: CacheData, isToken: boolean = false): Promise<void> {
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
                const chunk = data.txOrder.slice(i * MAX_ITEMS_PER_KEY, (i + 1) * MAX_ITEMS_PER_KEY);
                await this.db.put(`${addressOrTokenId}:txOrder:${i}`, chunk);
            }
            await this.db.put(`${addressOrTokenId}:txOrder:meta`, { pageCount, totalTxs });
            
            for (let i = 0; i < pageCount; i++) {
                const chunkKeys = data.txOrder.slice(i * MAX_ITEMS_PER_KEY, (i + 1) * MAX_ITEMS_PER_KEY);
                const chunkMap: Record<string, Transaction> = {};
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
    private async _updateGlobalMetadata(identifier: string, metadata: CacheMetadata, isToken: boolean = false): Promise<void> {
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
    public async _getGlobalMetadata(identifier: string, isToken: boolean = false): Promise<CacheMetadata | null> {
        const key = isToken ? `token:${identifier}` : `address:${identifier}`;
        // Try to get from in-memory cache
        if (this.globalMetadataCache.has(key)) {
            // Update recency ordering by re-inserting the key
            const metadata = this.globalMetadataCache.get(key)!;
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

    private async _initWebsocketForAddress(address: string): Promise<void> {
        try {
            return await this.failover.handleWebSocketOperation(async () => {
                this.wsManager.resetWsTimer(address, { isToken: false }, (addr: string) => {
                    this._setCacheStatus(addr, CACHE_STATUS.UNKNOWN);
                    this._resetMemoryCache(addr, false);
                });

                await this.wsManager.initWebsocketForAddress(address, async (addr: string, txid: string, msgType: WebSocketMessageType) => {
                    const key = `${addr}:${msgType}`;
                    if (msgType === 'TX_ADDED_TO_MEMPOOL') {
                        this._debounce(key, async () => {
                            const apiNumTxs = await this._quickGetTxCount(addr, 'address');
                            this._resetMemoryCache(addr, false);
                            await this._updateCache(addr, apiNumTxs, this.defaultPageSize);
                        });
                    } else if (msgType === 'TX_FINALIZED') {
                        this._debounce(key, async () => {
                            this._resetMemoryCache(addr, false);
                            await this._updateUnconfirmedTx(addr, txid);
                        });
                    }
                });
            }, address, 'WebSocket initialization');
        } catch (error) {
            this.logger.error('Error in websocket initialization, falling back to UNKNOWN status', error);
            this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
        }
    }

    private async _initWebsocketForToken(tokenId: string): Promise<void> {
        try {
            return await this.failover.handleWebSocketOperation(async () => {
                this.wsManager.resetWsTimer(tokenId, { isToken: true }, (id: string) => {
                    this._setCacheStatus(id, CACHE_STATUS.UNKNOWN, true);
                    this._resetMemoryCache(id, true);
                });

                await this.wsManager.initWebsocketForToken(tokenId, async (id: string, txid: string, msgType: WebSocketMessageType) => {
                    const key = `${id}:${msgType}`;
                    if (msgType === 'TX_ADDED_TO_MEMPOOL') {
                        this._debounce(key, async () => {
                            const apiNumTxs = await this._quickGetTxCount(id, 'token');
                            this._resetMemoryCache(id, true);
                            await this._updateTokenCache(id, apiNumTxs, this.defaultPageSize);
                        });
                    } else if (msgType === 'TX_FINALIZED') {
                        this._debounce(key, async () => {
                            this._resetMemoryCache(id, true);
                            await this._updateUnconfirmedTx(id, txid);
                        });
                    }
                });
            }, tokenId, 'WebSocket initialization');
        } catch (error) {
            this.logger.error('Error in websocket initialization for token, falling back to UNKNOWN status', error);
            this._setCacheStatus(tokenId, CACHE_STATUS.UNKNOWN, true);
        }
    }

    /* --------------------- 缓存状态管理方法 --------------------- */

    private _getCacheStatus(identifier: string, isToken: boolean = false): string {
        const isUpdating = this._isUpdating(identifier, isToken);
        if (isUpdating) {
            return CACHE_STATUS.UPDATING;
        }

        const statusMap = isToken ? this.tokenStatusMap : this.statusMap;
        const status = statusMap.get(identifier);
        return status?.status ?? CACHE_STATUS.UNKNOWN;
    }

    private _setCacheStatus(identifier: string, status: string, isToken: boolean = false): void {
        const now = Date.now();
        const targetMap = isToken ? this.tokenStatusMap : this.statusMap;
        const existingStatus = targetMap.get(identifier);
        
        // 添加详细的状态变化日志
        this.logger.log(`[${isToken ? 'Token' : 'Address'} ${identifier}] 
            Attempting to change status from ${existingStatus?.status} to ${status}
            Current update lock: ${this._isUpdating(identifier, isToken)}
        `);
        
        targetMap.set(identifier, {
            status: status as any,
            cacheTimestamp: existingStatus?.cacheTimestamp || now
        });
    }

    /* --------------------- Core Cache Update Logic --------------------- */

    private _isUpdating(identifier: string, isToken: boolean = false): boolean {
        const updateMap = isToken ? this.tokenUpdateLocks : this.updateLocks;
        return updateMap.has(identifier);
    }

    // 修改检查限制的方法名和实现
    private _checkTxLimit(identifier: string, numTxs: number, isToken: boolean = false): boolean {
        if (numTxs > this.maxTxLimit) {
            const idType = isToken ? 'Token' : 'Address';
            this.logger.log(`[${idType} ${identifier}] Transaction count (${numTxs}) exceeds maxTxLimit (${this.maxTxLimit}), setting to REJECT status`);
            this._setCacheStatus(identifier, CACHE_STATUS.REJECT, isToken);
            return true;
        }
        return false;
    }

    private async _checkAndUpdateCache(address: string, apiNumTxs: number, pageSize: number, forceUpdate: boolean = false): Promise<void> {
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

    private async _updateCache(address: string, totalNumTxs: number, pageSize: number): Promise<void> {
        return await this.failover.executeWithRetry(async () => {
            try {
                if (this._checkTxLimit(address, totalNumTxs)) {
                    return;
                }
                this.logger.log(`[${address}] Starting cache update.`);
                let currentPage = 0;
                let iterationCount = 0;
                const localCache = await this._readCache(address) || { txMap: {}, txOrder: [] };
                const localTxMap = new Map(Object.entries(localCache.txMap));
                let localTxOrder = localCache.txOrder;
                
                while (true) {
                    const currentSize = localTxMap.size;
                    this.logger.log(`[${address}] Updating cache page ${currentPage}, current size: ${currentSize}/${totalNumTxs}`);
                    
                    if (currentSize >= totalNumTxs) {
                        // Final sorting of txOrder before final cache write using the helper
                        localTxOrder = sortTxIds(Array.from(localTxMap.keys()), (key: string) => localTxMap.get(key));

                        // Always write the final state into the cache
                        this.logger.startTimer(`[${address}] Final write cache`);
                        const updatedData: CacheData = {
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
            
                    result.txs.forEach((tx: Transaction) => {
                        if (!localTxMap.has(tx.txid)) {
                            localTxMap.set(tx.txid, tx);
                        }
                    });
            
                    // Use helper function to sort txOrder
                    localTxOrder = sortTxIds(Array.from(localTxMap.keys()), (key: string) => localTxMap.get(key));
            
                    if (localTxMap.size >= 2000) {
                        if (iterationCount % 10 === 0) {
                            this.logger.startTimer(`[${address}] Write cache`);
                            const updatedData: CacheData = {
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
                        const updatedData: CacheData = {
                            txMap: Object.fromEntries(localTxMap),
                            txOrder: localTxOrder,
                        };
                        await this._writeCache(address, updatedData);
                        this.logger.endTimer(`[${address}] Write cache`);
                    }
            
                    currentPage++;
                    iterationCount++;
                }
                
                // Clean up memory after cache update
                localTxMap.clear();
                localTxOrder = [];
            
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
    private _convertScriptToAddress(type: string, hash: string): string {
        try {
            // Ensure hash is lowercase
            hash = hash.toLowerCase();
            // Use ecashaddrjs to convert script to ecash address
            const address = encodeCashAddress('ecash', type as any, hash);
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
    public script(type: string, hash: string) {
        return {
            history: async (pageOffset: number = 0, pageSize: number = 200): Promise<HistoryResponse> => {
                // Convert script to address and use existing address query logic
                const address = this._convertScriptToAddress(type, hash);
                return await this.getAddressHistory(address, pageOffset, pageSize);
            }
            // Add other script-related methods here if needed
        };
    }

    /* --------------------- External Interface Methods --------------------- */

    // Clear cache entries for an address by deleting both keys
    public async clearAddressCache(address: string): Promise<void> {
        await Promise.all([
            this.db.deletePaginated(`${address}:txMap`),
            this.db.deletePaginated(`${address}:txOrder`)
        ]);
        this.wsManager.unsubscribeAddress(address);
        this._setCacheStatus(address, CACHE_STATUS.UNKNOWN);
        this.logger.log(`Cache cleared for address: ${address}`);
    }

    public async clearAllCache(): Promise<void> {
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

    public async getAddressHistory(address: string, pageOffset: number = 0, pageSize: number = 200): Promise<HistoryResponse> {
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
                
                const wsTimeInfo = this.wsManager.getRemainingTime(address, { isToken: false });
                if (wsTimeInfo.active) {
                    // WebSocket is active
                } else {
                    // WebSocket is not active
                    if (currentStatus === CACHE_STATUS.LATEST) {
                        this._initWebsocketForAddress(address);
                    }
                }

                if (currentStatus === CACHE_STATUS.LATEST) {
                    this.wsManager.resetWsTimer(address, { isToken: false });
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

    private async _getPageFromCache(address: string, pageOffset: number, pageSize: number): Promise<HistoryResponse | null> {
        this.logger.startTimer(`[${address}] _getPageFromCache`);
        let cacheEntry = this.addressMemoryCache.get(address);
        const now = Date.now();

        if (cacheEntry) {
            // Check if entry expired
            if (now > cacheEntry.expiry) {
                this.logger.log(`[${address}] In-memory cache entry expired`);
                this.addressMemoryCache.delete(address);
                cacheEntry = undefined;
            } else {
                // Use memory cache
                cacheEntry.expiry += 10 * 1000;
                this.logger.log(`[${address}] Use memory cache`);
            }
        }

        let cache: CacheData;
        if (cacheEntry) {
            cache = cacheEntry.data;
        } else {
            this.logger.startTimer(`[${address}] Read persistent cache from DB`);
            const cacheResult = await this._readCache(address);
            this.logger.endTimer(`[${address}] Read DB cache`);
            if (!cacheResult) return null;
            cache = cacheResult;
            // Initial memory cache expiry time: 120 seconds
            this.addressMemoryCache.set(address, {
                data: cache,
                expiry: now + 120 * 1000
            });
        }

        const metadata = await this._getGlobalMetadata(address);
        if (!metadata) return null;

        // Ensure txOrder is sorted
        cache.txOrder = sortTxIds(cache.txOrder, (key: string) => cache.txMap[key]);

        // With 50% probability, compute hash and check consistency
        if (Math.random() < 0.5) {
            const newHash = computeHash(cache.txOrder);
            // Only output log when hash is changed
            if (newHash !== metadata.dataHash) {
                this.logger.log(`[${address}] newHash: ${newHash}, stored hash: ${metadata.dataHash}`);
                this.logger.log(`[${address}] Cache order hash mismatch detected. Triggering cache update and invalidating in-memory cache.`);
                this._checkAndUpdateCache(address, metadata.numTxs!, this.defaultPageSize, true);
                // Invalidate the in-memory cache since data is stale
                this._resetMemoryCache(address, false);
            }
        }

        const start = pageOffset * pageSize;
        const end = start + pageSize;
        let txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        await this._updatePageUnconfirmedTxs(address, cache, txs, false);

        // 重新获取可能已更新的交易数据
        txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        this.logger.endTimer(`[${address}] _getPageFromCache`);
        return {
            txs,
            numPages: Math.ceil(metadata.numTxs! / pageSize),
            numTxs: metadata.numTxs!
        };
    }

    public address(address: string) {
        return {
            history: async (pageOffset: number = 0, pageSize: number = 200): Promise<HistoryResponse> => {
                return await this.getAddressHistory(address, pageOffset, pageSize);
            }
            // Add other methods here if needed
        };
    }

    /* --------------------- Token Related Methods --------------------- */

    private async _checkAndUpdateTokenCache(tokenId: string, apiNumTxs: number, pageSize: number, forceUpdate: boolean = false): Promise<void> {
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

    private async _updateTokenCache(tokenId: string, totalNumTxs: number, pageSize: number): Promise<void> {
        return await this.failover.executeWithRetry(async () => {
            try {
                if (this._checkTxLimit(tokenId, totalNumTxs, true)) {
                    return;
                }

                this.logger.log(`[${tokenId}] Starting cache update.`);
                let currentPage = 0;
                let iterationCount = 0;
                const localCache = await this._readCache(tokenId) || { txMap: {}, txOrder: [] };
                const localTxMap = new Map(Object.entries(localCache.txMap));
                let localTxOrder = localCache.txOrder;
        
                while (true) {
                    const currentSize = localTxMap.size;
                    this.logger.log(`[${tokenId}] Updating cache page ${currentPage}, current size: ${currentSize}/${totalNumTxs}`);
        
                    if (currentSize >= totalNumTxs) {
                        // Re-sort the txOrder before final cache write
                        localTxOrder = sortTxIds(Array.from(localTxMap.keys()), (key: string) => localTxMap.get(key));
                        
                        // Always write the final state into the cache
                        this.logger.startTimer(`[${tokenId}] Final write cache`);
                        const updatedData: CacheData = {
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
        
                    result.txs.forEach((tx: Transaction) => {
                        if (!localTxMap.has(tx.txid)) {
                            localTxMap.set(tx.txid, tx);
                        }
                    });
        
                    localTxOrder = sortTxIds(Array.from(localTxMap.keys()), (key: string) => localTxMap.get(key));
        
                    if (localTxMap.size >= 2000) {
                        if (iterationCount % 10 === 0) {
                            this.logger.startTimer(`[${tokenId}] Write cache`);
                            const updatedData: CacheData = {
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
                        const updatedData: CacheData = {
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
                localTxMap.clear();
                localTxOrder = [];
        
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

    public async getTokenHistory(tokenId: string, pageOffset: number = 0, pageSize: number = 200): Promise<HistoryResponse> {
        const apiPageSize = Math.min(200, pageSize);
        const cachePageSize = Math.min(15000, pageSize);
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
                const wsTimeInfo = this.wsManager.getRemainingTime(tokenId, { isToken: true });
                if (wsTimeInfo.active) {
                    // WebSocket is active
                } else {
                    // WebSocket is not active
                    if (currentStatus === CACHE_STATUS.LATEST) {
                        this._initWebsocketForToken(tokenId).catch(err => this.logger.error(err));
                    }
                }

                if (currentStatus === CACHE_STATUS.LATEST) {
                    this.wsManager.resetWsTimer(tokenId, { isToken: true });
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

    public tokenId(tokenId: string) {
        return {
            history: async (pageOffset: number = 0, pageSize: number = 200): Promise<HistoryResponse> => {
                return await this.getTokenHistory(tokenId, pageOffset, pageSize);
            }
        };
    }

    // 修改 _quickGetTxCount 方法，添加重试机制
    private async _quickGetTxCount(identifier: string, type: 'address' | 'token' = 'address'): Promise<number> {
        return await this.failover.executeWithRetry(async () => {
            let result: HistoryResponse;
            if (type === 'address') {
                result = await this.chronik.address(identifier).history(0, 1);
            } else if (type === 'token') {
                result = await this.chronik.tokenId(identifier).history(0, 1);
            } else {
                throw new Error(`Unsupported type: ${type}`);
            }
            return result.numTxs;
        }, `quickGetTxCount for ${type} ${identifier}`);
    }

    // For token cache clear, rely on dbUtils.clearTokenCache (see below)
    public async clearTokenCache(tokenId: string): Promise<void> {
        await this.db.clearTokenCache(tokenId);
        if (typeof this.wsManager.unsubscribeToken === 'function') {
            this.wsManager.unsubscribeToken(tokenId);
        }
        this._setCacheStatus(tokenId, CACHE_STATUS.UNKNOWN, true);
        this.logger.log(`Cache cleared for token: ${tokenId}`);
    }

    // 修改 _updateUnconfirmedTx 方法，使其接受 addressOrTokenId 参数
    private async _updateUnconfirmedTx(addressOrTokenId: string, txid: string): Promise<void> {
        return this.txUpdateQueue.enqueue(async () => {
            try {
                const updatedTx = await this.chronik.tx(txid);
                const cache = await this._readCache(addressOrTokenId);
                if (!cache || !cache.txMap) {
                    this.logger.log(`[${addressOrTokenId}] Cache not found or empty when updating tx`);
                    return;
                }
                if (cache.txMap[txid]) {
                    cache.txMap[txid] = updatedTx;
                    cache.txOrder = sortTxIds(cache.txOrder, (key: string) => cache.txMap[key]);
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
    private async _updatePageUnconfirmedTxs(identifier: string, cache: CacheData, txsInCurrentPage: Transaction[], isToken: boolean = false): Promise<void> {
        const idType = isToken ? 'token' : 'address';
        let updated = false;

        // 筛选未确认交易（没有block.height字段的交易）
        const unconfirmedTxids = txsInCurrentPage
            .filter(tx => !tx.block || !tx.block.height)
            .map(tx => tx.txid);

        if (unconfirmedTxids.length === 0) {
            return; // 没有未确认交易，直接返回
        }

        this.logger.log(`[${idType} ${identifier}] Found ${unconfirmedTxids.length} unconfirmed transactions to check`);

        // 处理所有未确认交易
        await Promise.all(unconfirmedTxids.map(txid => 
            this.txUpdateQueue.enqueue(async () => {
                try {
                    const updatedTx = await this.chronik.tx(txid);
                    // 检查交易是否已确认（有block.height字段）
                    if (updatedTx && updatedTx.block && updatedTx.block.height) {
                        cache.txMap[txid] = updatedTx;
                        updated = true;
                        this.logger.log(`[${idType} ${identifier}] Tx ${txid} confirmed at height ${updatedTx.block.height}`);
                    }
                } catch (error) {
                    this.logger.error(`Error updating tx ${txid} in cache:`, error);
                }
            })
        ));

        if (updated) {
            cache.txOrder = sortTxIds(cache.txOrder, (key: string) => cache.txMap[key]);
            await this._writeCache(identifier, cache, isToken);
            this.logger.log(`[${idType} ${identifier}] Cache updated with newly confirmed transactions`);
        }
    }

    // 修改 token 的 getPageFromCache 方法
    private async _getTokenPageFromCache(tokenId: string, pageOffset: number, pageSize: number): Promise<HistoryResponse | null> {
        this.logger.startTimer(`[${tokenId}] _getTokenPageFromCache`);
        let cacheEntry = this.tokenMemoryCache.get(tokenId);
        const now = Date.now();

        if (cacheEntry) {
            if (now > cacheEntry.expiry) {
                this.logger.log(`[${tokenId}] In-memory token cache entry expired`);
                this.tokenMemoryCache.delete(tokenId);
                cacheEntry = undefined;
            } else {
                // Use memory cache
                cacheEntry.expiry += 10 * 1000;
                this.logger.log(`[${tokenId}] Use memory cache`);
            }
        }

        let cache: CacheData;
        if (cacheEntry) {
            cache = cacheEntry.data;
        } else {
            this.logger.startTimer(`[${tokenId}] Read persistent cache from DB`);
            const cacheResult = await this._readCache(tokenId);
            this.logger.endTimer(`[${tokenId}] Read DB cache`);
            if (!cacheResult) return null;
            cache = cacheResult;
            // Initial memory cache expiry time: 120 seconds
            this.tokenMemoryCache.set(tokenId, {
                data: cache,
                expiry: now + 120 * 1000
            });
        }

        const metadata = await this._getGlobalMetadata(tokenId, true);
        if (!metadata) return null;

        cache.txOrder = sortTxIds(cache.txOrder, (key: string) => cache.txMap[key]);

        // With 50% probability, compute hash and check consistency
        if (Math.random() < 0.5) {
            const newHash = computeHash(cache.txOrder);
            // Only output log when hash is changed
            if (newHash !== metadata.dataHash) {
                this.logger.log(`[${tokenId}] newHash: ${newHash}, stored hash: ${metadata.dataHash}`);
                this.logger.log(`[${tokenId}] Cache order hash mismatch detected. Triggering cache update and invalidating in-memory cache.`);
                this._checkAndUpdateTokenCache(tokenId, metadata.numTxs!, this.defaultPageSize, true);
                // Invalidate the in-memory cache since data is stale
                this._resetMemoryCache(tokenId, true);
            }
        }

        const start = pageOffset * pageSize;
        const end = start + pageSize;
        let txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        await this._updatePageUnconfirmedTxs(tokenId, cache, txs, true);

        // 重新获取可能已更新的交易数据
        txs = cache.txOrder.slice(start, end).map(txid => cache.txMap[txid]);

        this.logger.endTimer(`[${tokenId}] _getTokenPageFromCache`);
        return {
            txs,
            numPages: Math.ceil(metadata.numTxs! / pageSize),
            numTxs: metadata.numTxs!
        };
    }

    private _maintainGlobalMetadataCacheLimit(): void {
        while (this.globalMetadataCache.size > this.globalMetadataCacheLimit) {
            const oldestKey = this.globalMetadataCache.keys().next().value;
            this.globalMetadataCache.delete(oldestKey);
            this.logger.log(`Evicted globalMetadataCache entry for key ${oldestKey}`);
        }
    }

    // 新增公共方法 getCacheStatus, 方便用户直接查询缓存状态
    public getCacheStatus(identifier: string, isToken: boolean = false): string {
        if (isToken) {
            return this._getCacheStatus(identifier, true);
        }
        return this._getCacheStatus(identifier);
    }

    // Add a method to get statistics
    public async getStatistics(): Promise<CacheStatistics> {
        return await this.stats.getStatistics();
    }

    private _resetMemoryCache(identifier: string, isToken: boolean = false): void {
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
    private _startMemoryCacheExpirationCheckTimer(): void {
        // 每隔10秒检查一次是否有过期条目
        const checkInterval = 10 * 1000;
        
        const cleanupInterval = setInterval(() => {
            const now = Date.now();
            let addressCacheCleared = 0;
            let tokenCacheCleared = 0;

            // 检查 addressMemoryCache
            for (const [key, entry] of this.addressMemoryCache.entries()) {
                if (now > entry.expiry) {
                    this.addressMemoryCache.delete(key);
                    addressCacheCleared++;
                }
            }

            // 检查 tokenMemoryCache
            for (const [key, entry] of this.tokenMemoryCache.entries()) {
                if (now > entry.expiry) {
                    this.tokenMemoryCache.delete(key);
                    tokenCacheCleared++;
                }
            }

            // 只在清理了缓存时记录日志
            if (addressCacheCleared > 0 || tokenCacheCleared > 0) {
                this.logger.log(`Memory cache cleanup: ${addressCacheCleared} address entries, ${tokenCacheCleared} token entries cleared`);
            }
        }, checkInterval);

        // 保存定时器引用以便将来可以清理
        this.memoryCacheCleanupInterval = cleanupInterval;
    }

    // 添加清理方法，用于停止内存缓存相关的定时器
    public destroy(): void {
        if (this.memoryCacheCleanupInterval) {
            clearInterval(this.memoryCacheCleanupInterval);
        }
        
        // 清理防抖计时器
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }
}

export = ChronikCache; 

