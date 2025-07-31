// Cache status constants
export enum CacheStatus {
    UNKNOWN = 0,
    UPDATING = 1,
    REJECT = 2,
    LATEST = 3
}

// Cache configuration interface
export interface ChronikCacheConfig {
    maxTxLimit?: number;
    maxCacheSize?: number;
    failoverOptions?: FailoverOptions;
    enableLogging?: boolean;
    enableTimer?: boolean;
    wsTimeout?: number;
    wsExtendTimeout?: number;
}

// Failover configuration
export interface FailoverOptions {
    retryCount?: number;
    retryDelay?: number;
    fallbackUrls?: string[];
}

// Transaction data structure (from chronik-client)
export interface Transaction {
    txid: string;
    version: number;
    inputs: TransactionInput[];
    outputs: TransactionOutput[];
    lockTime: number;
    block?: BlockInfo;
    timeFirstSeen: number;
    size: number;
    isCoinbase: boolean;
    isFinal: boolean; // Added in chronik-client v1.4.0
    tokenEntries: TokenEntry[];
    tokenFailedParsings: TokenFailedParsing[];
    tokenStatus: string;
}

export interface TransactionInput {
    prevOut: OutPoint;
    inputScript: string;
    outputScript: string;
    sats: string; // Changed from 'value' to 'sats' in v3.0.0
    sequenceNo: number;
    token?: Token;
}

export interface TransactionOutput {
    sats: string; // Changed from 'value' to 'sats' in v3.0.0
    outputScript: string;
    token?: Token;
    spentBy?: OutPoint;
}

export interface OutPoint {
    txid: string;
    outIdx: number;
}

export interface BlockInfo {
    hash: string;
    height: number;
    timestamp: string;
}

export interface Token {
    tokenId: string;
    tokenType: TokenType;
    atoms: string; // Changed from 'amount' to 'atoms' in v3.0.0
    isMintBaton?: boolean;
}

export interface TokenType {
    protocol: string;
    type: string;
    number: number;
}

export interface TokenEntry {
    tokenId: string;
    tokenType: TokenType;
    txType: string;
    isInvalid: boolean;
    burnSummary: string;
    failedColorings: FailedColoring[];
    actualBurnAmount: string;
    intentionalBurn: string;
    burnsMintBatons: boolean;
}

export interface TokenFailedParsing {
    pushdataIdx: number;
    bytes: string;
    error: string;
}

export interface FailedColoring {
    pushdataIdx: number;
    error: string;
}

// History response structure
export interface HistoryResponse {
    txs: Transaction[];
    numPages: number;
    numTxs: number;
    status?: number;
    message?: string;
}

// Cache data structure
export interface CacheData {
    txMap: Record<string, Transaction>;
    txOrder: string[];
    numTxs?: number;
}

// Cache metadata
export interface CacheMetadata {
    accessCount: number;
    createdAt: number;
    lastAccessAt?: number;
    updatedAt?: number;
    dataHash?: string;
    numTxs?: number;
}

// Cache status info
export interface CacheStatusInfo {
    status: string;
    cacheTimestamp: number;
}

// WebSocket message types
export type WebSocketMessageType = 'TX_ADDED_TO_MEMPOOL' | 'TX_FINALIZED';

// WebSocket callback function
export type WebSocketCallback = (
    identifier: string,
    txid: string,
    msgType: WebSocketMessageType
) => Promise<void>;

// Script types (from ecashaddrjs)
export type ScriptType = 'p2pkh' | 'p2sh';

// Statistics interface
export interface CacheStatistics {
    totalAddresses: number;
    totalTokens: number;
    totalCacheSize: number;
    memoryUsage: {
        addressCache: number;
        tokenCache: number;
        globalMetadata: number;
    };
    hitRates: {
        addressHitRate: number;
        tokenHitRate: number;
    };
}

// Chronik client interface (minimal required methods)
export interface ChronikClientInterface {
    address(address: string): {
        history(pageOffset?: number, pageSize?: number): Promise<HistoryResponse>;
    };
    tokenId(tokenId: string): {
        history(pageOffset?: number, pageSize?: number): Promise<HistoryResponse>;
    };
    script(type: string, hash: string): {
        history(pageOffset?: number, pageSize?: number): Promise<HistoryResponse>;
    };
    tx(txid: string): Promise<Transaction>;
    ws?: any; // WebSocket related functionality
}

// Memory cache entry
export interface MemoryCacheEntry<T> {
    data: T;
    expiry: number;
} 