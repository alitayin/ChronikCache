# ChronikCache V0.3.4

ChronikCache is an npm package that provides a caching layer for Chronik.

---

## Features

- Local LevelDB-based caching of transaction histories.  
- Automatic cache updates when Chronik indicates new transactions.  
- WebSocket management with configurable timeout settings and caching failover/retry logic.  
- Flexible configuration for cache size, memory limit, page sizing, and WebSocket timeouts.  
- Script-to-address conversion (using [ecashaddrjs](https://www.npmjs.com/package/ecashaddrjs)).  
- Simple, fluent interface for fetching transaction history.  
- Token transaction history caching support.

---

## Installation

```bash
npm install chronik-cache
```

---

## Usage

Below is a basic example of how you can use ChronikCache in your Node.js application.

```js
const Chronik = require('chronik-client'); // Hypothetical Chronik client
const ChronikCache = require('chronik-cache');

const chronikCache = new ChronikCache(chronik, {
  maxMemory: 50000,                     // Maximum number of transactions to cache in memory
  maxCacheSize: 1024,                    // Maximum disk size in MB for the local cache
  failoverOptions: {                    // Options for the internal FailoverHandler
    retryAttempts: 3,
    retryDelayMs: 1500
  },
  wsTimeout: 86000000,                     // WebSocket timeout in milliseconds
  wsExtendTimeout: 43000000,              // Extended WebSocket timeout in milliseconds
  enableLogging: true
});
```

---

## Methods

### Address & Script Handling

ChronikCache provides fluent interfaces for addresses, scripts and tokens:

```javascript
// Retrieve transaction history for an address
const addressHistory = await chronikCache.address(address).history(pageOffset, pageSize);

// Retrieve transaction history for a script
const scriptHistory = await chronikCache.script(type, hash).history(pageOffset, pageSize);

// Retrieve transaction history for a token
const tokenHistory = await chronikCache.tokenId(tokenId).history(pageOffset, pageSize);

// All methods return: { txs: [...], numPages: number, numTxs: number }
```

---

### Cache Management

1. **clearAddressCache(address)**  
   Clears the local cache for a given address and unsubscribes the address's WebSocket connection.  
   ```js
   await chronikCache.clearAddressCache('ecash:qq...');
   ```

2. **clearAllCache()**  
   Clears all local caches and unsubscribes from all WebSocket connections.  
   ```js
   await chronikCache.clearAllCache();
   ```

3. **_getCacheStatus(address)**  
   Retrieves the internal cache status of an address (e.g., **`UNKNOWN`**, **`UPDATING`**, **`LATEST`**).  

---

 [MIT licensed](./LICENSE).