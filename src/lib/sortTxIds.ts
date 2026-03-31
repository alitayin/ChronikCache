// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

interface TxBlock {
    height: number;
    timestamp?: number;
}

interface Transaction {
    txid?: string;
    block?: TxBlock;
    timestamp?: number;
    timeFirstSeen: number;
}

/**
 * A helper function to sort transaction IDs based on corresponding transaction data
 */
export default function sortTxIds(txIds: string[], getTx: (txId: string) => Transaction): string[] {
    return txIds.sort((a, b) => {
        const txA = getTx(a);
        const txB = getTx(b);
        const txidA = txA?.txid || a;
        const txidB = txB?.txid || b;
        
        // 检查区块高度是否存在
        const hasHeightA = txA.block && typeof txA.block.height !== 'undefined';
        const hasHeightB = txB.block && typeof txB.block.height !== 'undefined';
        
        // 如果两个交易都没有区块高度，按 timeFirstSeen 倒序，再按 txid 反字母序
        if (!hasHeightA && !hasHeightB) {
            const timeFirstSeenDiff = txB.timeFirstSeen - txA.timeFirstSeen;
            if (timeFirstSeenDiff !== 0) {
                return timeFirstSeenDiff;
            }
            return txidB.localeCompare(txidA);
        }
        
        // 没有区块高度的排在前面
        if (!hasHeightA) return -1;
        if (!hasHeightB) return 1;
        
        // 都有区块高度，先比较高度
        const heightDiff = txB.block!.height - txA.block!.height;
        if (heightDiff !== 0) return heightDiff;
        
        // 同一区块内，按 timeFirstSeen 正序，再按 txid 反字母序
        const timeFirstSeenDiff = txA.timeFirstSeen - txB.timeFirstSeen;
        if (timeFirstSeenDiff !== 0) return timeFirstSeenDiff;
        
        return txidB.localeCompare(txidA);
    });
} 
