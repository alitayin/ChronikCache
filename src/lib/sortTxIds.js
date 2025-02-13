// A helper function to sort transaction IDs based on corresponding transaction data
function sortTxIds(txIds, getTx) {
    return txIds.sort((a, b) => {
        const txA = getTx(a);
        const txB = getTx(b);
        if (!txA.isFinal && !txB.isFinal) {
            return txB.timeFirstSeen - txA.timeFirstSeen;
        } else if (!txA.isFinal) {
            return -1;
        } else if (!txB.isFinal) {
            return 1;
        } else {
            const heightDiff = txB.block.height - txA.block.height;
            if (heightDiff !== 0) return heightDiff;
            return txB.block.timestamp - txA.block.timestamp;
        }
    });
}

module.exports = sortTxIds; 