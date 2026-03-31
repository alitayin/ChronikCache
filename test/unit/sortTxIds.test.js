const assert = require('node:assert/strict');
const sortTxIds = require('../../src/lib/sortTxIds').default;

describe('sortTxIds ordering guards', () => {
    it('orders confirmed txs by block height, then timeFirstSeen, then reverse alphabetical txid', () => {
        const txMap = {
            aaa: {
                txid: 'aaa',
                block: { height: 100, timestamp: 1000 },
                timeFirstSeen: 2000,
            },
            zzz: {
                txid: 'zzz',
                block: { height: 100, timestamp: 1000 },
                timeFirstSeen: 2000,
            },
            mid: {
                txid: 'mid',
                block: { height: 101, timestamp: 999 },
                timeFirstSeen: 1,
            },
        };

        const sorted = sortTxIds(['aaa', 'zzz', 'mid'], txid => txMap[txid]);

        assert.deepStrictEqual(sorted, ['mid', 'zzz', 'aaa']);
    });

    it('orders unconfirmed txs by descending timeFirstSeen, then reverse alphabetical txid', () => {
        const txMap = {
            aaa: {
                txid: 'aaa',
                timeFirstSeen: 500,
            },
            zzz: {
                txid: 'zzz',
                timeFirstSeen: 500,
            },
            old: {
                txid: 'old',
                timeFirstSeen: 100,
            },
        };

        const sorted = sortTxIds(['aaa', 'zzz', 'old'], txid => txMap[txid]);

        assert.deepStrictEqual(sorted, ['zzz', 'aaa', 'old']);
    });
});
