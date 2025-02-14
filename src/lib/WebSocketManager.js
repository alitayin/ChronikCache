const FailoverHandler = require('./failover');
const Logger = require('./Logger');
const { DEFAULT_CONFIG } = require('../constants');

class WebSocketManager {
    constructor(chronik, failoverOptions = {}, enableLogging = false, {
        wsTimeout = DEFAULT_CONFIG.WS_TIMEOUT,
        wsExtendTimeout = DEFAULT_CONFIG.WS_EXTEND_TIMEOUT,
        maxWsConnections = 30,
        onEvict = null
    } = {}) {
        this.chronik = chronik;
        this.wsSubscriptions = new Map();
        this.wsTimeouts = new Map();
        this.wsTimeoutExpirations = new Map();
        this.failover = new FailoverHandler(failoverOptions);
        this.logger = new Logger(enableLogging);
        this.wsTimeout = wsTimeout;
        this.wsExtendTimeout = wsExtendTimeout;
        this.maxWsConnections = maxWsConnections;
        this.onEvict = onEvict;
    }

    async initWebsocketForAddress(address, onNewTransaction) {
        return await this.failover.handleWebSocketOperation(
            async () => {
                if (this.wsSubscriptions.has(address)) {
                    this.logger.log(`[WS] Address ${address} is already subscribed.`);
                    this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
                    return;
                }

                // Evict oldest subscription if connection limit is reached
                while (this.wsSubscriptions.size >= this.maxWsConnections) {
                    this._evictOldestWs();
                }

                const ws = this.chronik.ws({
                    onMessage: async (msg) => {
                        this.logger.log('[WS] Received message:', msg);
                        if (msg.type === 'Tx') {
                            if (msg.msgType === 'TX_ADDED_TO_MEMPOOL' || msg.msgType === 'TX_FINALIZED') {
                                this.logger.log(`[WS] Transaction ${msg.msgType} for ${address}`);
                                try {
                                    await onNewTransaction(address, msg.txid, msg.msgType);
                                } catch (error) {
                                    this.logger.error(`[WS] Failed to update cache after transaction ${msg.msgType}:`, error);
                                }
                            }
                        }
                    },
                    onConnect: () => {
                        this.logger.log(`[WS] Connected for ${address}`);
                    },
                    onReconnect: () => {
                        this.logger.log(`[WS] Reconnected for ${address}`);
                        ws.subscribeToAddress(address);
                    },
                    onError: (error) => {
                        this.logger.error(`[WS] Error for ${address}:`, error);
                    },
                    onEnd: () => {
                        this.logger.log(`[WS] Connection ended for ${address}`);
                        this.wsSubscriptions.delete(address);
                        this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
                    }
                });

                await ws.waitForOpen();
                ws.subscribeToAddress(address);
                ws.subscriptionType = 'address';
                this.wsSubscriptions.set(address, ws);
                this.logger.log(`[WS] Successfully subscribed to ${address}`);
                this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
            },
            address,
            'WebSocket initialization'
        );
    }

    async initWebsocketForToken(tokenId, onNewTransaction) {
        return await this.failover.handleWebSocketOperation(
            async () => {
                if (this.wsSubscriptions.has(tokenId)) {
                    this.logger.log(`[WS] Token ${tokenId} is already subscribed.`);
                    this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
                    return;
                }

                // Evict oldest subscription if connection limit is reached
                while (this.wsSubscriptions.size >= this.maxWsConnections) {
                    this._evictOldestWs();
                }

                const ws = this.chronik.ws({
                    onMessage: async (msg) => {
                        this.logger.log('[WS] Received message:', msg);
                        if (msg.type === 'Tx') {
                            if (msg.msgType === 'TX_ADDED_TO_MEMPOOL' || msg.msgType === 'TX_FINALIZED') {
                                this.logger.log(`[WS] Transaction ${msg.msgType} for Token ${tokenId}`);
                                try {
                                    await onNewTransaction(tokenId, msg.txid, msg.msgType);
                                } catch (error) {
                                    this.logger.error(`[WS] Failed to update token cache after transaction ${msg.msgType}:`, error);
                                }
                            }
                        }
                    },
                    onConnect: () => {
                        this.logger.log(`[WS] Connected for Token ${tokenId}`);
                        ws.subscribeToTokenId(tokenId);
                    },
                    onReconnect: () => {
                        this.logger.log(`[WS] Reconnected for Token ${tokenId}`);
                        ws.subscribeToTokenId(tokenId);
                    },
                    onError: (error) => {
                        this.logger.error(`[WS] Error for Token ${tokenId}:`, error);
                    },
                    onEnd: () => {
                        this.logger.log(`[WS] Connection ended for Token ${tokenId}`);
                        this.wsSubscriptions.delete(tokenId);
                        this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
                    }
                });

                await ws.waitForOpen();
                ws.subscribeToTokenId(tokenId);
                ws.subscriptionType = 'token';
                this.wsSubscriptions.set(tokenId, ws);
                this.logger.log(`[WS] Successfully subscribed to Token ${tokenId}`);
                this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
            },
            tokenId,
            'WebSocket initialization'
        );
    }

    unsubscribeAddress(address) {
        const ws = this.wsSubscriptions.get(address);
        if (ws) {
            ws.unsubscribeFromAddress(address);
            this.wsSubscriptions.delete(address);
            this.logger.log(`[WS] Unsubscribed from ${address}`);
            this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
        }
    }

    unsubscribeAll() {
        for (const [key, ws] of this.wsSubscriptions) {
            if (ws.subscriptionType === 'address') {
                ws.unsubscribeFromAddress(key);
            } else if (ws.subscriptionType === 'token') {
                ws.unsubscribeFromTokenId(key);
            } else {
                ws.unsubscribeFromAddress(key);
            }
        }
        this.wsSubscriptions.clear();
        this.logger.log('[WS] Unsubscribed from all subscriptions (addresses and tokens).');
        this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
    }

    resetWsTimer(address, onTimeout) {
        const existingTimeout = this.wsTimeouts.get(address);
        const currentTime = Date.now();
        
        let newExpirationTime;
        if (existingTimeout) {
            const currentExpiration = this.wsTimeoutExpirations.get(address);
            newExpirationTime = currentExpiration + this.wsExtendTimeout;
            clearTimeout(existingTimeout);
        } else {
            newExpirationTime = currentTime + this.wsTimeout;
        }

        this.wsTimeoutExpirations.set(address, newExpirationTime);

        const timeoutDuration = newExpirationTime - currentTime;
        const timeout = setTimeout(() => {
            this.unsubscribeAddress(address);
            this.wsTimeouts.delete(address);
            this.wsTimeoutExpirations.delete(address);
            if (onTimeout) onTimeout(address);
            this.logger.log(`WebSocket for ${address} closed after ${Math.round(timeoutDuration / 1000)}s`);
        }, timeoutDuration);

        this.wsTimeouts.set(address, timeout);
    }

    getRemainingTime(address) {
        const expirationTime = this.wsTimeoutExpirations.get(address);
        if (!expirationTime) {
            return { active: false, message: 'No active WebSocket timer.' };
        }
        const remainMs = expirationTime - Date.now();
        if (remainMs <= 0) {
            return { active: false, message: 'WebSocket timer already expired.' };
        }
        const remainSec = Math.round(remainMs / 1000);
        return { active: true, remainingSec: remainSec };
    }

    _evictOldestWs() {
        const oldestKey = this.wsSubscriptions.keys().next().value;
        if (!oldestKey) return;
        const ws = this.wsSubscriptions.get(oldestKey);
        if (ws) {
            if (ws.subscriptionType === 'address') {
                ws.unsubscribeFromAddress(oldestKey);
            } else if (ws.subscriptionType === 'token') {
                ws.unsubscribeFromTokenId(oldestKey);
            } else {
                ws.unsubscribeFromAddress(oldestKey);
            }
            this.wsSubscriptions.delete(oldestKey);
            this.logger.log(`[WS] Evicted oldest subscription with key: ${oldestKey}`);
            if (this.onEvict && typeof this.onEvict === 'function') {
                this.onEvict(oldestKey, ws.subscriptionType);
            }
        }
    }
}

module.exports = WebSocketManager; 