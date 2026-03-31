const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
const DbUtils = require('../../src/lib/dbUtils').default;

describe('DbUtils bigint persistence guards', () => {
    let tempDir;
    let dbUtils;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), 'chronik-cache-test-'));
        dbUtils = new DbUtils(tempDir, {
            enableLogging: false,
            failoverOptions: {
                maxRetries: 1,
                retryDelay: 1,
                exponentialBackoff: false,
            },
        });
    });

    afterEach(async () => {
        if (dbUtils?.db) {
            await dbUtils.db.close();
        }
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it('round-trips bigint fields as bigint values', async () => {
        const payload = {
            output: {
                sats: 1234567890123456789n,
            },
            token: {
                atoms: 999999999999999999n,
            },
        };

        await dbUtils.put('bigint-payload', payload);
        const restored = await dbUtils.get('bigint-payload');

        assert.equal(typeof restored.output.sats, 'bigint');
        assert.equal(restored.output.sats, 1234567890123456789n);
        assert.equal(typeof restored.token.atoms, 'bigint');
        assert.equal(restored.token.atoms, 999999999999999999n);
    });

    it('does not coerce ordinary numeric-looking strings into bigint', async () => {
        const payload = {
            note: '12345678901234567890',
            nested: {
                label: '10000000000000000',
            },
        };

        await dbUtils.put('string-payload', payload);
        const restored = await dbUtils.get('string-payload');

        assert.equal(typeof restored.note, 'string');
        assert.equal(restored.note, '12345678901234567890');
        assert.equal(typeof restored.nested.label, 'string');
        assert.equal(restored.nested.label, '10000000000000000');
    });

    it('deletes paginated entries and their metadata', async () => {
        await dbUtils.put('entry:txMap:meta', { pageCount: 2 });
        await dbUtils.put('entry:txMap:0', { a: 1 });
        await dbUtils.put('entry:txMap:1', { b: 2 });

        await dbUtils.deletePaginated('entry:txMap');

        assert.equal(await dbUtils.get('entry:txMap:meta'), null);
        assert.equal(await dbUtils.get('entry:txMap:0'), null);
        assert.equal(await dbUtils.get('entry:txMap:1'), null);
    });

    it('stores and reads global metadata', async () => {
        const metadata = {
            accessCount: 1,
            createdAt: Date.now(),
            numTxs: 5,
        };

        await dbUtils.updateGlobalMetadata('address:ecash:test', metadata);
        const restored = await dbUtils.getGlobalMetadata('address:ecash:test');

        assert.deepStrictEqual(restored, metadata);
    });
});
