const assert = require('node:assert/strict');
const WebSocketManager = require('../../src/lib/WebSocketManager').default;
const { createWsMock } = require('../helpers/mockFactory');

describe('WebSocketManager', () => {
    it('subscribes an address only once', async () => {
        const ws = createWsMock();
        const chronik = {
            ws(config) {
                ws.config = config;
                return ws;
            },
        };

        const manager = new WebSocketManager(chronik, {}, false, {
            wsTimeout: 50,
            wsExtendTimeout: 10,
        });

        await manager.initWebsocketForAddress('ecash:addr1', async () => {});
        await manager.initWebsocketForAddress('ecash:addr1', async () => {});

        assert.deepStrictEqual(ws.subscribedAddresses, ['ecash:addr1']);
        manager.unsubscribeAll();
    });

    it('evicts the oldest address subscription when the limit is reached', async () => {
        const ws = createWsMock();
        const evicted = [];
        const chronik = {
            ws(config) {
                ws.config = config;
                return ws;
            },
        };

        const manager = new WebSocketManager(chronik, {}, false, {
            maxSubscriptions: 1,
            onEvict(identifier, type) {
                evicted.push({ identifier, type });
            },
        });

        await manager.initWebsocketForAddress('ecash:old', async () => {});
        await manager.initWebsocketForAddress('ecash:new', async () => {});

        assert.deepStrictEqual(evicted, [{ identifier: 'ecash:old', type: 'address' }]);
        assert.deepStrictEqual(ws.unsubscribedAddresses, ['ecash:old']);
        manager.unsubscribeAll();
    });

    it('forwards supported tx websocket messages to token subscriptions', async () => {
        const ws = createWsMock();
        const received = [];
        const chronik = {
            ws(config) {
                ws.config = config;
                return ws;
            },
        };

        const manager = new WebSocketManager(chronik, {}, false);
        await manager.initWebsocketForToken('token-1', async (tokenId, txid, msgType) => {
            received.push({ tokenId, txid, msgType });
        });

        await ws.config.onMessage({
            type: 'Tx',
            msgType: 'TX_ADDED_TO_MEMPOOL',
            txid: 'abc',
        });
        await ws.config.onMessage({
            type: 'Tx',
            msgType: 'UNRECOGNIZED',
            txid: 'ignored',
        });

        assert.deepStrictEqual(received, [
            { tokenId: 'token-1', txid: 'abc', msgType: 'TX_ADDED_TO_MEMPOOL' },
        ]);
        manager.unsubscribeAll();
    });

    it('resets and expires websocket timers', async () => {
        const ws = createWsMock();
        const timedOut = [];
        const chronik = {
            ws(config) {
                ws.config = config;
                return ws;
            },
        };

        const manager = new WebSocketManager(chronik, {}, false, {
            wsTimeout: 20,
            wsExtendTimeout: 5,
        });

        await manager.initWebsocketForAddress('ecash:timer', async () => {});
        manager.resetWsTimer('ecash:timer', { isToken: false }, identifier => {
            timedOut.push(identifier);
        });

        const activeInfo = manager.getRemainingTime('ecash:timer', { isToken: false });
        assert.equal(activeInfo.active, true);

        await new Promise(resolve => setTimeout(resolve, 30));

        assert.deepStrictEqual(timedOut, ['ecash:timer']);
        assert.equal(manager.getRemainingTime('ecash:timer', { isToken: false }).active, false);
    });

    it('re-subscribes known addresses on websocket reconnect', async () => {
        const ws = createWsMock();
        const chronik = {
            ws(config) {
                ws.config = config;
                return ws;
            },
        };

        const manager = new WebSocketManager(chronik, {}, false);
        await manager.initWebsocketForAddress('ecash:addr1', async () => {});
        ws.subscribedAddresses = [];

        ws.config.onConnect();

        assert.deepStrictEqual(ws.subscribedAddresses, ['ecash:addr1']);
        manager.unsubscribeAll();
    });

    it('closes the websocket when the last token subscription is removed', async () => {
        const ws = createWsMock();
        const chronik = {
            ws(config) {
                ws.config = config;
                return ws;
            },
        };

        const manager = new WebSocketManager(chronik, {}, false);
        await manager.initWebsocketForToken('token-1', async () => {});

        manager.unsubscribeToken('token-1');

        assert.equal(ws.manuallyClosed, true);
    });
});
