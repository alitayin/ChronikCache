# ChronikCache

High-performance caching layer for Chronik Indexer with automatic background updates and WebSocket synchronization.

## Installation

`npm install chronik-cache`

## Usage

```js
const { ChronikClient } = require('chronik-client');
const ChronikCache = require('chronik-cache');

// Create chronik client
const chronik = new ChronikClient('https://chronik.fabien.cash');

// Create cache with configuration
const cache = new ChronikCache(chronik, {
    maxTxLimit: 50000,          // Max transactions before rejecting cache
    maxCacheSize: 1024,         // Max cache size in MB
    enableLogging: false,       // Disable logging
    wsTimeout: 86000000,        // WebSocket timeout in ms
    failoverOptions: {
        retryAttempts: 3,
        retryDelayMs: 1500
    }
});

// Get address transaction history (cached)
const addressHistory = await cache.address('ecash:qq...').history(0, 200);

// Get token transaction history (cached)  
const tokenHistory = await cache.tokenId('tokenId...').history(0, 200);

// Get script history (cached)
const scriptHistory = await cache.script('p2pkh', 'hash...').history(0, 200);

// Cache management
await cache.clearAddressCache('ecash:qq...');
await cache.clearTokenCache('tokenId...');
await cache.clearAllCache();

// Check cache status
const status = cache.getCacheStatus('ecash:qq...');
console.log('Cache status:', status); // UNKNOWN, UPDATING, LATEST, or REJECT

// Get cache statistics
const stats = await cache.getStatistics();
console.log('Cache stats:', stats);
```

## Features

- **Automatic Updates**: Background cache synchronization via WebSocket
- **LevelDB Storage**: Fast local key-value storage for transaction data
- **Token Support**: Full caching support for SLP/eToken transactions
- **Script Conversion**: Automatic script-to-address conversion using ecashaddrjs
- **Failover Logic**: Built-in retry mechanisms and error handling
- **Status Tracking**: Real-time cache status monitoring
- **Memory Optimization**: Configurable cache limits and automatic cleanup

## Response Status Codes

Cached responses include a `status` field:

- **No status** - Data served from cache
- **Status 1** - Cache being prepared (>200 tx requests)
- **Status 2** - Transaction limit exceeded, served from API
- **Status 3** - Fallback to direct API call

## Configuration Options

```js
{
    maxTxLimit: 50000,              // Max transactions before cache rejection
    maxCacheSize: 1024,             // Cache size limit in MB
    enableLogging: true,            // Enable/disable logging
    enableTimer: false,             // Enable/disable performance timers
    wsTimeout: 86000000,            // WebSocket timeout (ms)
    wsExtendTimeout: 43000000,      // Extended WebSocket timeout (ms)
    failoverOptions: {              // Retry configuration
        retryAttempts: 3,
        retryDelayMs: 1500
    }
}
```

## GitHub

[@https://github.com/alitayin/ChronikCache](https://github.com/alitayin/ChronikCache)

[MIT licensed](./LICENSE)