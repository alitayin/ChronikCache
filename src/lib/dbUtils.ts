// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

import { Level } from 'level';
import FailoverHandler from './failover';
import Logger from './Logger';

interface DbUtilsOptions {
    valueEncoding?: string;
    maxCacheSize?: number;
    enableLogging?: boolean;
    failoverOptions?: any;
}

interface CacheEntry {
    identifier: string;
    accessCount: number;
    size: number;
}

interface MetaData {
    pageCount: number;
}

export default class DbUtils {
    public db: Level<string, any>;
    private maxCacheSize: number;
    public cacheDir: string;
    private failover: FailoverHandler;
    private logger: Logger;

    /**
     * @param cacheDir Database file path
     * @param options Optional parameters
     */
    constructor(cacheDir: string, options: DbUtilsOptions = {}) {
        const { maxCacheSize = Infinity, enableLogging = false } = options;
        this.db = new Level(cacheDir, { 
            valueEncoding: {
                format: 'utf8',
                encode: (obj: any) => JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? v.toString() : v),
                decode: (str: string) => JSON.parse(str, (_k, v) => typeof v === 'string' && /^\d{16,}$/.test(v) ? BigInt(v) : v)
            }
        });
        this.maxCacheSize = maxCacheSize;
        this.cacheDir = cacheDir;
        this.failover = new FailoverHandler(options.failoverOptions || {});
        this.logger = new Logger(enableLogging);
    }

    /**
     * Unified DB read operation handler
     */
    async get(key: string, defaultValue: any = null): Promise<any> {
        return await this.failover.handleDbOperation(
            async () => {
                try {
                    return await this.db.get(key);
                } catch (error: any) {
                    if (error.notFound) {
                        return defaultValue;
                    }
                    throw error;
                }
            },
            `DB get operation for ${key}`
        );
    }

    /**
     * Unified DB write operation handler
     */
    async put(key: string, value: any): Promise<void> {
        return await this.failover.handleDbOperation(
            async () => {
                await this.db.put(key, value);
            },
            `DB put operation for ${key}`
        );
    }

    /**
     * Unified DB delete operation handler
     */
    async del(key: string): Promise<void> {
        return await this.failover.handleDbOperation(
            async () => {
                await this.db.del(key);
            },
            `DB delete operation for ${key}`
        );
    }

    /**
     * Calculate cache size
     */
    async calculateCacheSize(): Promise<number> {
        const result = await this.failover.handleDbOperation(
            async () => {
                let totalSize = 0;
                for await (const [key, value] of this.db.iterator()) {
                    // 同时计算key和value的字节大小
                    totalSize += Buffer.byteLength(key, 'utf8');
                    totalSize += Buffer.byteLength(JSON.stringify(value), 'utf8');
                }
                return totalSize;
            },
            'Calculate cache size operation'
        );
        return result as number;
    }

    /**
     * Provide iterator interface for reading all key-value pairs
     */
    async *iterator(): AsyncGenerator<[string, any], void, unknown> {
        try {
            for await (const [key, value] of this.db.iterator()) {
                yield [key, value];
            }
        } catch (error) {
            this.logger.error('Error in iterator:', error);
            throw error;
        }
    }

    /**
     * Clear database
     */
    async clear(): Promise<void> {
        return await this.failover.handleDbOperation(
            async () => {
                await this.db.clear();
            },
            'Clear database operation'
        );
    }

    /**
     * Clean least accessed entries in cache
     */
    async cleanLeastAccessedCache(): Promise<void> {
        try {
            let currentSize = await this.calculateCacheSize();
            this.logger.log(`Initial cache size: ${currentSize} bytes, max allowed size: ${this.maxCacheSize}`);

            const entries: CacheEntry[] = [];
            for await (const [key, value] of this.db.iterator()) {
                const size = Buffer.byteLength(JSON.stringify(value), 'utf8');

                // 获取全局元数据中的访问计数
                const metadata = await this.getGlobalMetadata(key);
                const accessCount = metadata?.accessCount || 0;

                this.logger.log(`[Debug] Found entry: ${key}, accessCount: ${accessCount}, size: ${size}`);

                entries.push({
                    identifier: key,
                    accessCount,
                    size
                });
            }

            entries.sort((a, b) => a.accessCount - b.accessCount);

            let i = 0;
            while (currentSize > this.maxCacheSize && i < entries.length) {
                const entry = entries[i];
                this.logger.log(`[Debug] Attempting to remove entry: ${entry.identifier}, currentSize: ${currentSize}`);
                await this.del(entry.identifier);
                // 同时删除对应的全局元数据
                await this.del(`metadata:${entry.identifier}`);
                currentSize -= entry.size;
                this.logger.log(`Cleaned cache for ${entry.identifier}, access count: ${entry.accessCount}`);
                i++;
            }

            if (currentSize > this.maxCacheSize) {
                this.logger.log('[Debug] Cache is still above limit after cleanup. Aborting update.');
                throw new Error('Cache size remains above the limit, abort update to avoid concurrent removal and updating.');
            }

            this.logger.log(`Cache cleanup completed, removed ${i} entries, final size: ${currentSize} bytes`);
        } catch (error) {
            this.logger.error('Error cleaning cache:', error);
            throw error;
        }
    }

    /**
     * Clear all cache
     */
    async clearAll(): Promise<void> {
        try {
            await this.db.clear();
        } catch (error) {
            this.logger.error('Error clearing all keys:', error);
        }
    }

    /**
     * Delete data stored in a paginated manner.
     */
    async deletePaginated(keyBase: string): Promise<void> {
        return await this.failover.handleDbOperation(
            async () => {
                try {
                    const meta: MetaData = await this.db.get(`${keyBase}:meta`);
                    if (meta) {
                        const { pageCount } = meta;
                        for (let i = 0; i < pageCount; i++) {
                            await this.del(`${keyBase}:${i}`);
                        }
                        await this.del(`${keyBase}:meta`);
                        return;
                    }
                } catch {
                    // If meta not found, fall through.
                }
                await this.del(keyBase);
            },
            `DB delete paginated operation for ${keyBase}`
        );
    }

    /**
     * Unified DB token cache delete operation handler with pagination support
     */
    async clearTokenCache(tokenId: string): Promise<void> {
        return await this.failover.handleDbOperation(
            async () => {
                await this.deletePaginated(`${tokenId}:txMap`);
                await this.deletePaginated(`${tokenId}:txOrder`);
                await this.del(`metadata:token:${tokenId}`);
            },
            `DB clear token cache operation for ${tokenId}`
        );
    }

    /**
     * 添加用于存储全局元数据的方法
     */
    async updateGlobalMetadata(key: string, data: any): Promise<void> {
        return await this.failover.handleDbOperation(
            async () => {
                await this.db.put(`metadata:${key}`, data);
            },
            `DB update global metadata operation for ${key}`
        );
    }

    /**
     * 添加用于获取全局元数据的方法
     */
    async getGlobalMetadata(key: string, defaultValue: any = null): Promise<any> {
        return await this.failover.handleDbOperation(
            async () => {
                try {
                    return await this.db.get(`metadata:${key}`);
                } catch (error: any) {
                    if (error.notFound) {
                        return defaultValue;
                    }
                    throw error;
                }
            },
            `DB get global metadata operation for ${key}`
        );
    }
} 
