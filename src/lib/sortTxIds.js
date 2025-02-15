// A helper function to sort transaction IDs based on corresponding transaction data
function sortTxIds(txIds, getTx) {
    return txIds.sort((a, b) => {
        const txA = getTx(a);
        const txB = getTx(b);
        
        // 检查区块高度是否存在
        const hasHeightA = txA.block && typeof txA.block.height !== 'undefined';
        const hasHeightB = txB.block && typeof txB.block.height !== 'undefined';
        
        // 如果两个交易都没有区块高度，按照 timestamp 和 timeFirstSeen 排序
        if (!hasHeightA && !hasHeightB) {
            const timestampDiff = txB.timestamp - txA.timestamp;
            return timestampDiff !== 0 ? timestampDiff : txB.timeFirstSeen - txA.timeFirstSeen;
        }
        
        // 没有区块高度的排在前面
        if (!hasHeightA) return -1;
        if (!hasHeightB) return 1;
        
        // 都有区块高度，先比较高度
        const heightDiff = txB.block.height - txA.block.height;
        if (heightDiff !== 0) return heightDiff;
        
        // 同一区块内，按照 timestamp 和 timeFirstSeen 排序
        const timestampDiff = txB.block.timestamp - txA.block.timestamp;
        return timestampDiff !== 0 ? timestampDiff : txB.timeFirstSeen - txA.timeFirstSeen;
    });
}

module.exports = sortTxIds; 