const { Level } = require('level');
const FailoverHandler = require('./failover');
const Logger = require('./Logger');

class DbUtils {
    /**
     * @param {string} cacheDir Database file path
     * @param {object} options Optional parameters
     * @param {string} [options.valueEncoding='json'] LevelDB encoding method
     * @param {number} [options.maxCacheSize=Infinity] Maximum cache size (in bytes)
     * @param {boolean} [options.enableLogging=false] Enable logging
     */
    constructor(cacheDir, options = {}) {
        const { valueEncoding = 'json', maxCacheSize = Infinity, enableLogging = false } = options;
        this.db = new Level(cacheDir, { valueEncoding });
        this.maxCacheSize = maxCacheSize;
        this.cacheDir = cacheDir;
        this.failover = new FailoverHandler(options.failoverOptions || {});
        this.logger = new Logger(enableLogging);
    }

    // Unified DB read operation handler
    async get(key, defaultValue = null) {
        return await this.failover.handleDbOperation(
            async () => {
                try {
                    return await this.db.get(key);
                } catch (error) {
                    if (error.notFound) {
                        return defaultValue;
                    }
                    throw error;
                }
            },
            `DB get operation for ${key}`
        );
    }

    // Unified DB write operation handler
    async put(key, value) {
        return await this.failover.handleDbOperation(
            async () => {
                await this.db.put(key, value);
            },
            `DB put operation for ${key}`
        );
    }

    // Unified DB delete operation handler
    async del(key) {
        return await this.failover.handleDbOperation(
            async () => {
                await this.db.del(key);
            },
            `DB delete operation for ${key}`
        );
    }

    // Calculate cache size
    async calculateCacheSize() {
        return await this.failover.handleDbOperation(
            async () => {
                let totalSize = 0;
                for await (const [_, value] of this.db.iterator()) {
                    totalSize += Buffer.byteLength(JSON.stringify(value), 'utf8');
                }
                return totalSize;
            },
            'Calculate cache size operation'
        );
    }

    // Provide iterator interface for reading all key-value pairs
    async *iterator() {
        try {
            for await (const [key, value] of this.db.iterator()) {
                yield [key, value];
            }
        } catch (error) {
            this.logger.error('Error in iterator:', error);
            throw error;
        }
    }

    // Clear database
    async clear() {
        return await this.failover.handleDbOperation(
            async () => {
                await this.db.clear();
            },
            'Clear database operation'
        );
    }

    // Clean least accessed entries in cache
    async cleanLeastAccessedCache() {
        try {
            let currentSize = await this.calculateCacheSize();
            this.logger.log(`Initial cache size: ${currentSize} bytes, max allowed size: ${this.maxCacheSize}`);

            const entries = [];
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

    // Clear all cache
    async clearAll() {
        try {
            await this.db.clear();
        } catch (error) {
            this.logger.error('Error clearing all keys:', error);
        }
    }

    // Delete data stored in a paginated manner.
    async deletePaginated(keyBase) {
        return await this.failover.handleDbOperation(
            async () => {
                try {
                    const meta = await this.db.get(`${keyBase}:meta`);
                    if (meta) {
                        const { pageCount } = meta;
                        for (let i = 0; i < pageCount; i++) {
                            await this.del(`${keyBase}:${i}`);
                        }
                        await this.del(`${keyBase}:meta`);
                        return;
                    }
                } catch (error) {
                    // If meta not found, fall through.
                }
                await this.del(keyBase);
            },
            `DB delete paginated operation for ${keyBase}`
        );
    }

    // Unified DB token cache delete operation handler with pagination support
    async clearTokenCache(tokenId) {
        return await this.failover.handleDbOperation(
            async () => {
                await this.deletePaginated(`${tokenId}:txMap`);
                await this.deletePaginated(`${tokenId}:txOrder`);
                await this.del(`metadata:token:${tokenId}`);
            },
            `DB clear token cache operation for ${tokenId}`
        );
    }

    // 添加用于存储全局元数据的方法
    async updateGlobalMetadata(key, data) {
        return await this.failover.handleDbOperation(
            async () => {
                await this.db.put(`metadata:${key}`, data);
            },
            `DB update global metadata operation for ${key}`
        );
    }

    // 添加用于获取全局元数据的方法
    async getGlobalMetadata(key, defaultValue = null) {
        return await this.failover.handleDbOperation(
            async () => {
                try {
                    return await this.db.get(`metadata:${key}`);
                } catch (error) {
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

module.exports = DbUtils; 