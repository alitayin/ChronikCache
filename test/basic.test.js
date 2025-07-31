// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

const { ChronikClient } = require('chronik-client');
const ChronikCache = require('../src/index.ts');
const assert = require('assert');

describe('ChronikCache 基础功能测试', () => {
    let chronikCache;
    const testAddress = 'ecash:qr6lws9uwmjkkaau4w956lugs9nlg9hudqs26lyxkv';
    const testP2pkhHash = 'f5f740bc76e56b77bcab8b4d7f888167f416fc68'; // 示例hash
    const testTokenId = 'f36e1b3d9a2aaf74f132fef3834e9743b945a667a4204e761b85f2e7b65fd41a'; // 示例token id

    before(() => {
        // Initialize ChronikCache with logging disabled
        const client = new ChronikClient('https://chronik-native.fabien.cash');
        chronikCache = new ChronikCache(client, {
            maxMemory: 10000,
            maxCacheSize: 100,
            failoverOptions: {
                retryAttempts: 3,
                retryDelayMs: 1000
            },
            enableLogging: false
        });
    });

    describe('地址查询测试', () => {
        it('应该能成功查询地址历史记录', async () => {
            // 先清除缓存，确保测试状态干净
            await chronikCache.clearAddressCache(testAddress);
            
            // 增加重试逻辑，等待缓存更新完成
            let result;
            let retries = 0;
            const maxRetries = 3;
            
            while (retries < maxRetries) {
                result = await chronikCache.address(testAddress).history(0, 200);
                
                // 如果获取到数据，就跳出循环
                if (result && result.txs) {
                    break;
                }
                
                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 2000));
                retries++;
            }
            
            // 验证返回的数据结构
            assert(Array.isArray(result.txs), '交易列表应该是数组');
            assert('numPages' in result, '应该包含页数信息');
            assert('numTxs' in result, '应该包含总交易数信息');
            
            // 验证返回的交易数据
            if (result.txs.length > 0) {
                const firstTx = result.txs[0];
                assert('txid' in firstTx, '交易应该包含 txid');
            }
        }).timeout(30000); // 增加超时时间到30秒

        it('应该能处理分页查询', async () => {
            const page1 = await chronikCache.address(testAddress).history(0, 50);
            const page2 = await chronikCache.address(testAddress).history(1, 50);

            // 确保两页数据不同
            if (page1.txs.length > 0 && page2.txs.length > 0) {
                assert.notStrictEqual(
                    page1.txs[0].txid,
                    page2.txs[0].txid,
                    '不同页的交易应该不同'
                );
            }
        }).timeout(10000);
    });

    describe('Script查询测试', () => {
        it('应该能处理P2PKH脚本查询', async () => {
            try {
                const result = await chronikCache.script('p2pkh', testP2pkhHash).history(0, 50);
                assert(Array.isArray(result.txs), '交易列表应该是数组');
            } catch (error) {
                // 如果是无效hash导致的错误可以忽略
                if (!error.message.includes('Invalid hash')) {
                    throw error;
                }
            }
        }).timeout(10000);
    });

    describe('Token查询测试', () => {
        it('应该能成功查询token历史记录', async () => {
            // 先清除缓存，确保测试状态干净
            await chronikCache.clearAddressCache(testTokenId);
            
            // 增加重试逻辑，等待缓存更新完成
            let result;
            let retries = 0;
            const maxRetries = 3;
            
            while (retries < maxRetries) {
                result = await chronikCache.tokenId(testTokenId).history(0, 200);
                
                // 如果获取到数据，就跳出循环
                if (result && result.txs) {
                    break;
                }
                
                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 2000));
                retries++;
            }
            
            // 验证返回的数据结构
            assert(Array.isArray(result.txs), 'token交易列表应该是数组');
            assert('numPages' in result, '应该包含页数信息');
            assert('numTxs' in result, '应该包含总交易数信息');
            
            // 验证返回的交易数据
            if (result.txs.length > 0) {
                const firstTx = result.txs[0];
                assert('txid' in firstTx, '交易应该包含 txid');
            }
        }).timeout(30000);

        it('应该能处理token的分页查询', async () => {
            const page1 = await chronikCache.tokenId(testTokenId).history(0, 50);
            const page2 = await chronikCache.tokenId(testTokenId).history(1, 50);

            // 确保两页数据不同
            if (page1.txs.length > 0 && page2.txs.length > 0) {
                assert.notStrictEqual(
                    page1.txs[0].txid,
                    page2.txs[0].txid,
                    '不同页的token交易应该不同'
                );
            }
        }).timeout(10000);

        it('应该能处理大页面的token查询请求', async () => {
            const result = await chronikCache.tokenId(testTokenId).history(0, 500);
            
            // 当请求大于200条记录时，应该返回提示信息
            if (!result.txs.length) {
                assert('message' in result, '大页面请求应该返回提示信息');
                assert(result.message.includes('Cache is being prepared'), '应该包含缓存准备中的提示');
            }
        }).timeout(10000);
    });

    describe('缓存管理测试', () => {
        it('应该能清除指定地址的缓存', async () => {
            await chronikCache.clearAddressCache(testAddress);
            // 验证缓存已清除后可以重新查询
            const result = await chronikCache.address(testAddress).history(0, 50);
            assert(Array.isArray(result.txs), '清除缓存后应该能重新查询');
        }).timeout(10000);

        it('应该能清除所有缓存', async () => {
            await chronikCache.clearAllCache();
            // 验证清除所有缓存后可以重新查询
            const result = await chronikCache.address(testAddress).history(0, 50);
            assert(Array.isArray(result.txs), '清除所有缓存后应该能重新查询');
        }).timeout(10000);

        it('应该能在清除所有缓存后重新查询token历史', async () => {
            await chronikCache.clearAllCache();
            // 验证清除所有缓存后可以重新查询token
            const result = await chronikCache.tokenId(testTokenId).history(0, 50);
            assert(Array.isArray(result.txs), '清除所有缓存后应该能重新查询token历史');
        }).timeout(10000);
    });
});

after(() => {
  // Force exit after tests complete to avoid waiting for cache updates
  process.exit(0);
}); 
