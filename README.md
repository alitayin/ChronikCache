# ChronikCache V0.9.1

ChronikCache is an npm package that provides a caching layer for Chronik.  

- ChronikCache can be used seamlessly, as it automatically updates its cache in the background, including unconfirmed transaction updates via the `.history` method.  
- The data is stored using a LevelDB key-value storage, ensuring fast read/write operations. However, LevelDB does not support simultaneous multi-process read/write operations, so a proxy or an alternative mediator is required in such scenarios.  
- If you require a larger cache capacity (e.g., caching 100000 transactions), ensure that adequate memory is allocated to your process.  
- There remains significant room for optimization in caching read/write performance.

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
  enableLogging: false
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

ChronikCache provides the following methods to manage cache for addresses and tokens:

1. **clearAddressCache(address)**
   - Clears the local cache for the given address. This method deletes both the `txMap` and `txOrder` entries (including paginated keys) and unsubscribes from the address's WebSocket connection.
   - Example:
     ```js
     await chronikCache.clearAddressCache('ecash:qq...');
     ```

2. **clearTokenCache(tokenId)**
   - Clears the cache for the specified token and, if supported, unsubscribes from its WebSocket connection.
   - Example:
     ```js
     await chronikCache.clearTokenCache('tokenId...');
     ```

3. **clearAllCache()**
   - Clears all local caches (for both addresses and tokens) and unsubscribes from all WebSocket connections.
   - Example:
     ```js
     await chronikCache.clearAllCache();
     ```

4. **getCacheStatus(identifier, isToken = false)**
   - Retrieves the current cache status for an address or token.
   - For addresses, pass the address string as the `identifier`, and for tokens, pass `true` as the second parameter.
   - Possible status values include:
     - `UNKNOWN`: The cache status is unknown or uninitialized.
     - `UPDATING`: The cache is currently being updated.
     - `LATEST`: The cache is up to date.
   - Example:
     ```js
     const status = chronikCache.getCacheStatus('ecash:qq...');
     console.log(`Cache status: ${status}`);
     ```

---

For more details, visit my GitHub repository: [@https://github.com/alitayin/ChronikCache](https://github.com/alitayin/ChronikCache)

 [MIT licensed](./LICENSE).