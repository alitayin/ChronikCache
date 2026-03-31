// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

const { ChronikClient } = require('chronik-client');
const ChronikCache = require('../src/index.ts');
const assert = require('node:assert/strict');

async function retry(fn, attempts = 3, delayMs = 1500) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < attempts - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastError;
}

describe('ChronikCache 集成 smoke tests', function () {
    this.timeout(45000);

    let chronikCache;
    const testAddress = 'ecash:qr6lws9uwmjkkaau4w956lugs9nlg9hudqs26lyxkv';
    const testP2pkhHash = 'f5f740bc76e56b77bcab8b4d7f888167f416fc68';
    const testTokenId = 'f36e1b3d9a2aaf74f132fef3834e9743b945a667a4204e761b85f2e7b65fd41a';

    before(function () {
        if (process.env.RUN_CHRONIK_INTEGRATION !== '1') {
            this.skip();
        }
        const client = new ChronikClient('https://chronik-native1.fabien.cash');
        chronikCache = new ChronikCache(client, {
            maxCacheSize: 100,
            enableLogging: false,
        });
    });

    after(async () => {
        if (!chronikCache) {
            return;
        }
        chronikCache.destroy();
        if (chronikCache.db?.db?.close) {
            await chronikCache.db.db.close();
        }
    });

    it('returns address history structure', async () => {
        const result = await retry(async () => {
            const response = await chronikCache.address(testAddress).history(0, 50);
            assert(Array.isArray(response.txs));
            return response;
        });

        assert.equal(typeof result.numPages, 'number');
        assert.equal(typeof result.numTxs, 'number');
        if (result.txs.length > 0) {
            assert.equal(typeof result.txs[0].txid, 'string');
        }
    });

    it('returns script history structure for p2pkh', async () => {
        const result = await retry(() => chronikCache.script('p2pkh', testP2pkhHash).history(0, 25));
        assert(Array.isArray(result.txs));
        assert.equal(typeof result.numPages, 'number');
        assert.equal(typeof result.numTxs, 'number');
    });

    it('returns token history structure', async () => {
        const result = await retry(() => chronikCache.tokenId(testTokenId).history(0, 50));
        assert(Array.isArray(result.txs));
        assert.equal(typeof result.numPages, 'number');
        assert.equal(typeof result.numTxs, 'number');
    });

    it('returns warming response or data for large token page request', async () => {
        const result = await retry(() => chronikCache.tokenId(testTokenId).history(0, 500));

        if (result.status === 1) {
            assert.match(result.message, /Cache is being prepared/);
            assert.deepStrictEqual(result.txs, []);
        } else {
            assert(Array.isArray(result.txs));
        }
    });

    it('can clear caches and query again', async () => {
        await chronikCache.clearAddressCache(testAddress);
        await chronikCache.clearTokenCache(testTokenId);
        await chronikCache.clearAllCache();

        const addressResult = await retry(() => chronikCache.address(testAddress).history(0, 25));
        const tokenResult = await retry(() => chronikCache.tokenId(testTokenId).history(0, 25));

        assert(Array.isArray(addressResult.txs));
        assert(Array.isArray(tokenResult.txs));
    });
});
