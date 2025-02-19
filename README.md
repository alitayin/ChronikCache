# ChronikCache V1.0.6

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
- Flexible configuration for cache size, transaction limit, page sizing, and WebSocket timeouts.  
- Script-to-address conversion (using [ecashaddrjs](https://www.npmjs.com/package/ecashaddrjs)).  
- Simple, fluent interface for fetching transaction history.  
- Token transaction history caching support.
- Additional utility methods like cache statistics retrieval.

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
  maxTxLimit: 50000,                     // Maximum allowed transaction count before rejecting cache update
  maxCacheSize: 1024,                    // Maximum disk size in MB for the local cache
  failoverOptions: {                     // Options for the internal FailoverHandler
    retryAttempts: 3,
    retryDelayMs: 1500
  },
  wsTimeout: 86000000,                     // WebSocket timeout in milliseconds
  wsExtendTimeout: 43000000,              // Extended WebSocket timeout in milliseconds
  enableLogging: false,                   // Disable Logging
    enableTimer: false                   // Disable Logging-Timer
});

// Example of retrieving address history
(async () => {
  const address = 'ecash:qq...'; // Replace with a valid address
  const history = await chronikCache.address(address).history(0, 200);
  console.log('Address History:', history);
})();

// Example of retrieving token history
(async () => {
  const tokenId = 'tokenId...'; // Replace with a valid tokenId
  const history = await chronikCache.tokenId(tokenId).history(0, 200);
  console.log('Token History:', history);
})();

// Example of retrieving cache statistics
(async () => {
  const stats = await chronikCache.getStatistics();
  console.log('Cache Statistics:', stats);
})();
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
     - `REJECT`: The transaction count exceeds the allowed limit.
   - Example:
     ```js
     const status = chronikCache.getCacheStatus('ecash:qq...');
     console.log(`Cache status: ${status}`);
     ```

5. **getStatistics()**
   - Retrieves statistics and performance metrics related to the cache.
   - Example:
     ```js
     const stats = await chronikCache.getStatistics();
     console.log('Cache Statistics:', stats);
     ```

---

## Cache Return Status

The returned data contains a `status` field that indicates the state and source of the data. The meanings are as follows:

- **Status 1 – Cache In Preparation**  
  **Description:**  
  When a user requests more than 200 transactions and the cache is still being built, the system returns status 1. No actual transaction data is provided in this response; instead, a message is given indicating that the cache is being prepared.

- **Status 2 – Cache Limit Exceeded**  
  **Description:**  
  When the transaction count for an address or token exceeds the configured `maxTxLimit`, the cache update is rejected. In this scenario, data is fetched directly from the Chronik API and the response includes status 2, which informs the user that the cache was bypassed due to exceeding the limit.

- **Status 3 – Direct API Fallback**  
  **Description:**  
  In other cases—such as when a non-cached method is called or during fallback scenarios—the system returns data directly from the Chronik API with status 3. This status indicates that the data does not originate from the cache or that the cache status is not applicable.

---

For more details, visit my GitHub repository: [@https://github.com/alitayin/ChronikCache](https://github.com/alitayin/ChronikCache)

 [MIT licensed](./LICENSE).