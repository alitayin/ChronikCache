# ChronikCache V0.1

ChronikCache is an npm package that provides a caching layer for Chronik.

---

## Features

- Local LevelDB-based caching of transaction histories.  
- Automatic cache updates when Chronik indicates new transactions.  
- WebSocket management and caching failover/retry logic.  
- Flexible configuration for cache size, memory limit, and page sizing.  
- Script-to-address conversion (using [ecashaddrjs](https://www.npmjs.com/package/ecashaddrjs)).  
- Simple, fluent interface for fetching transaction history.  

---

## Installation

```bash
npm install chronikcache
```

---

## Usage

Below is a basic example of how you can use ChronikCache in your Node.js application.

```js
const Chronik = require('chronik-client'); // Hypothetical Chronik client
const ChronikCache = require('chronikcache');

const chronikCache = new ChronikCache(chronik, {
  maxMemory: 50000,                     // Max transaction count to cache in memory
  maxCacheSize: 100,                    // Max disk size in MB for the local cache
  failoverOptions: {                    // Options passed to the internal FailoverHandler
    retryAttempts: 3,
    retryDelayMs: 1500
  }
});
```

---

## Methods

### Address & Script Handling

ChronikCache provides fluent interfaces for both addresses and scripts:

```javascript
// Get transaction history for an address
const addressHistory = await chronikCache.address(address).history(pageOffset, pageSize);

// Get transaction history for a script
const scriptHistory = await chronikCache.script(type, hash).history(pageOffset, pageSize);

// Both methods return: { txs: [...], numPages: number, numTxs: number }
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