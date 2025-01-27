# ChronikCache V0.1

ChronikCache is an npm package that provides a caching layer for Chronik

## Features

- Local LevelDB-based caching of transaction histories.  
- Automatic cache updates when Chronik indicates new transactions.  
- WebSocket management and caching failover/retry logic.  
- Flexible configuration for cache size, memory limit, and page sizing.  
- Script-to-address conversion (using [ecashaddrjs](https://www.npmjs.com/package/ecashaddrjs)).  
- Simple, fluent interface for fetching transaction history.  

## Installation

```bash
npm install chronikcache
```

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

## Methods

### Address Handling

ChronikCache provides a fluent interface for addresses:

```js
chronikCache.address(address).history(pageOffset, pageSize);
```

- `address`: A valid eCash address.  
- `pageOffset`: The page number to start fetching from.  
- `pageSize`: The number of transactions per page.  


### Script Handling

ChronikCache can also handle scripts by converting them to eCash addresses under the hood:

```js
chronikCache.script(type, hash).history(pageOffset, pageSize);
```

- `type`: The script type (e.g., `p2pkh`).  
- `hash`: The script's hash.  


### Cache Management

1. **clearAddressCache(address)**  
   Clears the local cache for a given address and unsubscribes the address’s WebSocket connection.  
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

```
## License

ChronikCache is [MIT licensed](./LICENSE). Feel free to use it in your own projects. For issues or feature requests, please open an issue in our GitHub repository.