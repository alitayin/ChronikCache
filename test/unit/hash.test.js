const assert = require('node:assert/strict');
const { computeHash } = require('../../src/lib/hash');

describe('computeHash', () => {
    it('returns the same hash for the same input', () => {
        const data = ['a', 'b', 'c'];
        assert.equal(computeHash(data), computeHash(data));
    });

    it('returns different hashes for different input', () => {
        assert.notEqual(computeHash(['a']), computeHash(['b']));
    });
});
