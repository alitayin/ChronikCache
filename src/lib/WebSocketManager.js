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
                    this.logger.log(`[WS] Address ${address} is already subscribed. Current WS: ${this.wsSubscriptions.size}`);
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
                        ws.subscribeToAddress(address);
                    },
                    onReconnect: () => {
                        this.logger.log(`[WS] Reconnecting for ${address}`);
                        
                        const reconnectTimeout = setTimeout(() => {
                            this.logger.log(`[WS] Reconnection timeout for ${address}`);
                            ws.manuallyClosed = true;
                            this.unsubscribeAddress(address);
                        }, 5000);

                        const originalOnConnect = ws.onConnect;
                        ws.onConnect = (e) => {
                            clearTimeout(reconnectTimeout);
                            if (originalOnConnect) originalOnConnect(e);
                        };
                    },
                    onError: (error) => {
                        this.logger.error(`[WS] Error for ${address}:`, error);
                        // 在错误处理时标记为手动关闭，防止自动重连
                        ws.manuallyClosed = true;
                        this.unsubscribeAddress(address);
                        const existingTimeout = this.wsTimeouts.get(address);
                        if (existingTimeout) {
                            clearTimeout(existingTimeout);
                            this.wsTimeouts.delete(address);
                            this.wsTimeoutExpirations.delete(address);
                        }
                    },
                    onEnd: () => {
                        this.logger.log(`[WS] Connection ended for ${address}`);
                        this.wsSubscriptions.delete(address);
                        // 清理定时器
                        const existingTimeout = this.wsTimeouts.get(address);
                        if (existingTimeout) {
                            clearTimeout(existingTimeout);
                            this.wsTimeouts.delete(address);
                            this.wsTimeoutExpirations.delete(address);
                        }
                        this.logger.log(`[WS] Current WS: ${this.wsSubscriptions.size}`);
                    }
                });

                await ws.waitForOpen();
                ws.subscribeToAddress(address);
                ws.subscriptionType = 'address';
                this.wsSubscriptions.set(address, ws);
                this.logger.log(`[WS] ✅ Subscribed  to ${address}. Current WS: ${this.wsSubscriptions.size}`);
            },
            address,
            'WebSocket initialization'
        );
    }

    async initWebsocketForToken(tokenId, onNewTransaction) {
        return await this.failover.handleWebSocketOperation(
            async () => {
                if (this.wsSubscriptions.has(tokenId)) {
                    this.logger.log(`[WS] Token ${tokenId} is already subscribed. Current subscription count: ${this.wsSubscriptions.size}`);
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
                        ws.subscribeToTokenId(tokenId);
                    },
                    onReconnect: () => {
                        this.logger.log(`[WS] Reconnecting for Token ${tokenId}`);
                        
                        const reconnectTimeout = setTimeout(() => {
                            this.logger.log(`[WS] Reconnection timeout for Token ${tokenId}`);
                            ws.manuallyClosed = true;
                            this.unsubscribeToken(tokenId);
                        }, 5000);

                        const originalOnConnect = ws.onConnect;
                        ws.onConnect = (e) => {
                            clearTimeout(reconnectTimeout);
                            if (originalOnConnect) originalOnConnect(e);
                        };
                    },
                    onError: (error) => {
                        this.logger.error(`[WS] Error for Token ${tokenId}:`, error);
                        // 在错误处理时标记为手动关闭，防止自动重连
                        ws.manuallyClosed = true;
                        this.unsubscribeToken(tokenId);
                        const existingTimeout = this.wsTimeouts.get(tokenId);
                        if (existingTimeout) {
                            clearTimeout(existingTimeout);
                            this.wsTimeouts.delete(tokenId);
                            this.wsTimeoutExpirations.delete(tokenId);
                        }
                    },
                    onEnd: () => {
                        this.logger.log(`[WS] Connection ended for Token ${tokenId}`);
                        this.wsSubscriptions.delete(tokenId);
                        // 清理定时器
                        const existingTimeout = this.wsTimeouts.get(tokenId);
                        if (existingTimeout) {
                            clearTimeout(existingTimeout);
                            this.wsTimeouts.delete(tokenId);
                            this.wsTimeoutExpirations.delete(tokenId);
                        }
                        this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
                    }
                });

                await ws.waitForOpen();
                ws.subscribeToTokenId(tokenId);
                ws.subscriptionType = 'token';
                this.wsSubscriptions.set(tokenId, ws);
                this.logger.log(`[WS] ✅ Subscribed to Token ${tokenId}. Current subscription count: ${this.wsSubscriptions.size}`);
            },
            tokenId,
            'WebSocket initialization'
        );
    }

    unsubscribeAddress(address) {
        const ws = this.wsSubscriptions.get(address);
        if (ws) {
            ws.unsubscribeFromAddress(address);
            ws.close();  // 关闭连接
            this.wsSubscriptions.delete(address);
            this.logger.log(`[WS] Unsubscribed from ${address}. Current subscription count: ${this.wsSubscriptions.size}`);
        }
    }

    unsubscribeToken(tokenId) {
        const ws = this.wsSubscriptions.get(tokenId);
        if (ws) {
            ws.unsubscribeFromTokenId(tokenId);
            ws.close();  // 关闭连接
            this.wsSubscriptions.delete(tokenId);
            this.logger.log(`[WS] Unsubscribed from token ${tokenId}. Current subscription count: ${this.wsSubscriptions.size}`);
        }
    }

    unsubscribeAll() {
        for (const [key, ws] of this.wsSubscriptions) {
            if (ws.subscriptionType === 'address') {
                ws.unsubscribeFromAddress(key);
            } else if (ws.subscriptionType === 'token') {
                ws.unsubscribeFromTokenId(key);
            }
            ws.close();  // 关闭每个连接
        }
        this.wsSubscriptions.clear();
        this.logger.log('[WS] Unsubscribed from all subscriptions (addresses and tokens).');
        this.logger.log(`[WS] Current subscription count: ${this.wsSubscriptions.size}`);
    }

    resetWsTimer(identifier, { isToken = false } = {}, onTimeout = null) {
        const existingTimeout = this.wsTimeouts.get(identifier);
        const currentTime = Date.now();
        
        let newExpirationTime;
        if (existingTimeout) {
            const currentExpiration = this.wsTimeoutExpirations.get(identifier);
            newExpirationTime = currentExpiration + this.wsExtendTimeout;
            clearTimeout(existingTimeout);
        } else {
            newExpirationTime = currentTime + this.wsTimeout;
        }
    
        this.wsTimeoutExpirations.set(identifier, newExpirationTime);
    
        const timeoutDuration = newExpirationTime - currentTime;
        const MAX_SET_TIMEOUT = 1296000000; // 15天的最大超时时间（毫秒）
        const effectiveTimeoutDuration = Math.min(timeoutDuration, MAX_SET_TIMEOUT);
    
        const timeout = setTimeout(() => {
            const ws = this.wsSubscriptions.get(identifier);
            if (ws) {
                if (isToken) {
                    this.unsubscribeToken(identifier);
                } else {
                    this.unsubscribeAddress(identifier);
                }
            }
            this.wsTimeouts.delete(identifier);
            this.wsTimeoutExpirations.delete(identifier);
            if (onTimeout) onTimeout(identifier);
            this.logger.log(`WebSocket for ${isToken ? 'Token ' : ''}${identifier} closed after ${Math.round(effectiveTimeoutDuration / 1000)}s`);
        }, effectiveTimeoutDuration);
    
        this.wsTimeouts.set(identifier, timeout);
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
            ws.close();  // 添加这行来关闭WebSocket连接
            this.wsSubscriptions.delete(oldestKey);
            this.logger.log(`[WS] Evicted oldest subscription with key: ${oldestKey}. Current subscription count: ${this.wsSubscriptions.size}`);
            if (this.onEvict && typeof this.onEvict === 'function') {
                this.onEvict(oldestKey, ws.subscriptionType);
            }
        }
    }
}

module.exports = WebSocketManager; 