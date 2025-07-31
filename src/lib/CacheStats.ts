// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

import Logger from './Logger';

interface SizeStats {
    total: number;
    transactions: number;
    metadata: number;
    other: number;
}

interface DatabaseStats {
    totalSize: string;
    maxSize: string;
    cacheDir: string;
    sizeBreakdown?: {
        transactions: string;
        metadata: string;
        other: string;
    };
}

interface ItemSample {
    identifier: string;
    status: string;
    createdAt: string;
    lastAccessAt: string | null;
    accessCount: number;
    numTxs: number;
}

interface ItemStats {
    total: number;
    byStatus: Record<string, number>;
    samples: ItemSample[];
}

interface SystemStats {
    globalMetadataCache: {
        size: number;
        limit: number;
    };
    websocket: {
        activeConnections: number;
        subscriptions: number;
    };
    configuration: {
        maxTxLimit: number;
        maxCacheSize: string;
        defaultPageSize: number;
        cacheDir: string;
    };
}

interface QueueStats {
    updateQueue: {
        currentLength: number;
        maxConcurrency: number;
    };
    txUpdateQueue: {
        currentLength: number;
        maxConcurrency: number;
    };
}

interface CacheStatistics {
    items: ItemStats;
    system: SystemStats;
    queues: QueueStats;
    database: DatabaseStats;
}

interface ChronikCache {
    db: any;
    getCacheStatus: (identifier: string, isToken: boolean) => string | null;
    _getGlobalMetadata: (identifier: string, isToken: boolean) => Promise<any>;
    globalMetadataCache: Map<string, any>;
    globalMetadataCacheLimit: number;
    wsManager: any;
    updateQueue?: any;
    txUpdateQueue?: any;
    [key: string]: any;  // Allow access to private properties
}

export default class CacheStats {
    private cache: ChronikCache;
    private logger: Logger;

    constructor(chronikCache: ChronikCache, logger: Logger) {
        this.cache = chronikCache;
        this.logger = logger;
    }

    async getStatistics(): Promise<CacheStatistics> {
        try {
            const dbStats = await this._getDbStats();
            
            const stats: CacheStatistics = {
                items: await this._getItemStats(),
                system: this._getSystemStats(),
                queues: this._getQueueStats(),
                database: dbStats
            };
            
            return stats;
        } catch (error) {
            this.logger.error('Error getting cache statistics:', error);
            throw error;
        }
    }

    private async _getDbStats(): Promise<DatabaseStats> {
        try {
            const totalSize = await this.cache.db.calculateCacheSize();
            const maxSize = this.cache.maxCacheSize;
            
            // 简化分类统计，不再区分 address 和 token
            const sizeStats: SizeStats = {
                total: totalSize,
                transactions: 0,  // 合并 address 和 token 的交易数据
                metadata: 0,
                other: 0
            };

            // 遍历数据库统计不同类型数据
            const db = this.cache.db.db;
            for await (const [key, value] of db.iterator()) {
                const entrySize = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
                
                if (key.startsWith('metadata:')) {
                    sizeStats.metadata += entrySize;
                } else if (key.includes(':txOrder') || key.includes(':txMap')) {
                    sizeStats.transactions += entrySize;
                } else {
                    sizeStats.other += entrySize;
                }
            }

            return {
                totalSize: `${(totalSize / (1024 * 1024)).toFixed(2)}MB`,
                maxSize: `${(maxSize / (1024 * 1024)).toFixed(2)}MB`,
                cacheDir: this.cache.cacheDir,
                sizeBreakdown: {
                    transactions: `${(sizeStats.transactions / (1024 * 1024)).toFixed(2)}MB`,
                    metadata: `${(sizeStats.metadata / (1024 * 1024)).toFixed(2)}MB`,
                    other: `${(sizeStats.other / (1024 * 1024)).toFixed(2)}MB`
                }
            };
        } catch (error) {
            this.logger.error('Error getting DB stats:', error);
            return {
                totalSize: 'Unknown',
                maxSize: `${(this.cache.maxCacheSize / (1024 * 1024)).toFixed(2)}MB`,
                cacheDir: this.cache.cacheDir
            };
        }
    }

    private async _getItemStats(): Promise<ItemStats> {
        const stats: ItemStats = {
            total: 0,
            byStatus: {},
            samples: []
        };

        try {
            // Collect identifiers from database keys containing txOrder
            const itemSet = new Set<string>();
            for await (const [key] of this.cache.db.db.iterator()) {
                if (key.includes(':txOrder')) {
                    // Use the key string up to the last ':' as identifier.
                    const identifier = key.substring(0, key.lastIndexOf(':'));
                    itemSet.add(identifier);
                }
            }
            stats.total = itemSet.size;

            // Process each identifier: determine if it's token or address based on prefix
            for (const identifier of itemSet) {
                // If identifier does not start with 'ecash:', assume it's a token
                const isToken = !identifier.startsWith('ecash:');
                const status = this.cache.getCacheStatus(identifier, isToken) || 'UNKNOWN';
                stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
                
                // Append sample data if less than 5 samples for this status
                if (stats.samples.filter(s => s.status === status).length < 5) {
                    const metadata = await this.cache._getGlobalMetadata(identifier, isToken);
                    if (metadata) {
                        stats.samples.push({
                            identifier: identifier,
                            status: status,
                            createdAt: new Date(metadata.createdAt).toISOString(),
                            lastAccessAt: metadata.lastAccessAt ? new Date(metadata.lastAccessAt).toISOString() : null,
                            accessCount: metadata.accessCount || 0,
                            numTxs: metadata.numTxs || 0
                        });
                    }
                }
            }
        } catch (error) {
            this.logger.error('Error getting item stats:', error);
        }
        return stats;
    }

    private _getSystemStats(): SystemStats {
        return {
            globalMetadataCache: {
                size: this.cache.globalMetadataCache.size,
                limit: this.cache.globalMetadataCacheLimit
            },
            websocket: {
                activeConnections: this.cache.wsManager.wsSubscriptions.size,
                subscriptions: this.cache.wsManager.wsSubscriptions.size
            },
            configuration: {
                maxTxLimit: this.cache.maxTxLimit,
                maxCacheSize: `${this.cache.maxCacheSize / (1024 * 1024)}MB`,
                defaultPageSize: this.cache.defaultPageSize,
                cacheDir: this.cache.cacheDir
            }
        };
    }

    private _getQueueStats(): QueueStats {
        return {
            updateQueue: {
                currentLength: this.cache.updateQueue?.getQueueLength() || 0,
                maxConcurrency: this.cache.updateQueue?.maxConcurrency || 2
            },
            txUpdateQueue: {
                currentLength: this.cache.txUpdateQueue?.getQueueLength() || 0,
                maxConcurrency: this.cache.txUpdateQueue?.maxConcurrency || 5
            }
        };
    }
} 
