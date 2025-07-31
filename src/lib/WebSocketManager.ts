// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

import FailoverHandler from './failover';
import Logger from './Logger';
import { DEFAULT_CONFIG } from '../constants';

interface SubscriptionData {
    onNewTransaction: (identifier: string, txid: string, msgType: string) => Promise<void>;
    timeout: NodeJS.Timeout | null;
    expiry: number | null;
}

interface WebSocketManagerOptions {
    wsTimeout?: number;
    wsExtendTimeout?: number;
    maxSubscriptions?: number;
    onEvict?: ((identifier: string, type: 'address' | 'token') => void) | null;
}

interface ChronikWebSocket {
    subscribeToAddress: (address: string) => void;
    unsubscribeFromAddress: (address: string) => void;
    subscribeToTokenId: (tokenId: string) => void;
    unsubscribeFromTokenId: (tokenId: string) => void;
    close: () => void;
    readyState: number;
    manuallyClosed: boolean;
    waitForOpen: () => Promise<void>;
}

interface ChronikClient {
    ws?: (config: any) => ChronikWebSocket;
}

export default class WebSocketManager {
    private chronik: ChronikClient;
    
    // WebSocket instances (one for addresses, one for tokens)
    public addressWs: ChronikWebSocket | null;
    public tokenWs: ChronikWebSocket | null;
    
    // Subscription management
    private addressSubscriptions: Map<string, SubscriptionData>;
    private tokenSubscriptions: Map<string, SubscriptionData>;
    
    private failover: FailoverHandler;
    private logger: Logger;
    private wsTimeout: number;
    private wsExtendTimeout: number;
    private maxSubscriptions: number;
    private onEvict: ((identifier: string, type: 'address' | 'token') => void) | null;

    constructor(
        chronik: ChronikClient, 
        failoverOptions: any = {}, 
        enableLogging: boolean = false, 
        options: WebSocketManagerOptions = {}
    ) {
        const {
            wsTimeout = DEFAULT_CONFIG.WS_TIMEOUT,
            wsExtendTimeout = DEFAULT_CONFIG.WS_EXTEND_TIMEOUT,
            maxSubscriptions = 30,
            onEvict = null
        } = options;

        this.chronik = chronik;
        
        // WebSocket instances (one for addresses, one for tokens)
        this.addressWs = null;
        this.tokenWs = null;
        
        // Subscription management
        this.addressSubscriptions = new Map(); // address -> { onNewTransaction, timeout, expiry }
        this.tokenSubscriptions = new Map();   // tokenId -> { onNewTransaction, timeout, expiry }
        
        this.failover = new FailoverHandler(failoverOptions);
        this.logger = new Logger(enableLogging);
        this.wsTimeout = wsTimeout;
        this.wsExtendTimeout = wsExtendTimeout;
        this.maxSubscriptions = maxSubscriptions;
        this.onEvict = onEvict;
    }

    private async _ensureAddressWs(): Promise<ChronikWebSocket> {
        if (this.addressWs && !this.addressWs.manuallyClosed) {
            return this.addressWs;
        }

        this.addressWs = this.chronik.ws!({
            onMessage: async (msg: any) => {
                this.logger.log('[Address WS] Received message:', msg);
                if (msg.type === 'Tx') {
                    if (msg.msgType === 'TX_ADDED_TO_MEMPOOL' || msg.msgType === 'TX_FINALIZED') {
                        // Find which address this transaction belongs to
                        for (const [address, subscription] of this.addressSubscriptions) {
                            try {
                                await subscription.onNewTransaction(address, msg.txid, msg.msgType);
                            } catch (error) {
                                this.logger.error(`[Address WS] Failed to handle transaction for ${address}:`, error);
                            }
                        }
                    }
                }
            },
            onConnect: () => {
                this.logger.log('[Address WS] Connected');
                // Re-subscribe to all addresses
                for (const address of this.addressSubscriptions.keys()) {
                    this.addressWs!.subscribeToAddress(address);
                }
            },
            onReconnect: () => {
                this.logger.log('[Address WS] Reconnecting');
            },
            onError: (error: Error) => {
                this.logger.error('[Address WS] Error:', error);
            },
            onEnd: () => {
                this.logger.log('[Address WS] Connection ended');
                this.addressWs = null;
            }
        });

        await this.addressWs.waitForOpen();
        this.logger.log('[Address WS] ✅ Address WebSocket instance created');
        return this.addressWs;
    }

    private async _ensureTokenWs(): Promise<ChronikWebSocket> {
        if (this.tokenWs && !this.tokenWs.manuallyClosed) {
            return this.tokenWs;
        }

        this.tokenWs = this.chronik.ws!({
            onMessage: async (msg: any) => {
                this.logger.log('[Token WS] Received message:', msg);
                if (msg.type === 'Tx') {
                    if (msg.msgType === 'TX_ADDED_TO_MEMPOOL' || msg.msgType === 'TX_FINALIZED') {
                        // Find which token this transaction belongs to
                        for (const [tokenId, subscription] of this.tokenSubscriptions) {
                            try {
                                await subscription.onNewTransaction(tokenId, msg.txid, msg.msgType);
                            } catch (error) {
                                this.logger.error(`[Token WS] Failed to handle transaction for ${tokenId}:`, error);
                            }
                        }
                    }
                }
            },
            onConnect: () => {
                this.logger.log('[Token WS] Connected');
                // Re-subscribe to all tokens
                for (const tokenId of this.tokenSubscriptions.keys()) {
                    this.tokenWs!.subscribeToTokenId(tokenId);
                }
            },
            onReconnect: () => {
                this.logger.log('[Token WS] Reconnecting');
            },
            onError: (error: Error) => {
                this.logger.error('[Token WS] Error:', error);
            },
            onEnd: () => {
                this.logger.log('[Token WS] Connection ended');
                this.tokenWs = null;
            }
        });

        await this.tokenWs.waitForOpen();
        this.logger.log('[Token WS] ✅ Token WebSocket instance created');
        return this.tokenWs;
    }

    async initWebsocketForAddress(address: string, onNewTransaction: (address: string, txid: string, msgType: string) => Promise<void>): Promise<void> {
        return await this.failover.handleWebSocketOperation(
            async () => {
                if (this.addressSubscriptions.has(address)) {
                    this.logger.log(`[Address WS] Address ${address} already subscribed. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
                    return;
                }

                // Evict oldest subscription if limit is reached
                while (this.addressSubscriptions.size >= this.maxSubscriptions) {
                    this._evictOldestAddressSubscription();
                }

                const ws = await this._ensureAddressWs();
                ws.subscribeToAddress(address);

                this.addressSubscriptions.set(address, {
                    onNewTransaction,
                    timeout: null,
                    expiry: null
                });

                this.logger.log(`[Address WS] ✅ Subscribed to ${address}. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
            },
            address,
            'Address WebSocket subscription'
        );
    }

    async initWebsocketForToken(tokenId: string, onNewTransaction: (tokenId: string, txid: string, msgType: string) => Promise<void>): Promise<void> {
        return await this.failover.handleWebSocketOperation(
            async () => {
                if (this.tokenSubscriptions.has(tokenId)) {
                    this.logger.log(`[Token WS] Token ${tokenId} already subscribed. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
                    return;
                }

                // Evict oldest subscription if limit is reached
                while (this.tokenSubscriptions.size >= this.maxSubscriptions) {
                    this._evictOldestTokenSubscription();
                }

                const ws = await this._ensureTokenWs();
                ws.subscribeToTokenId(tokenId);

                this.tokenSubscriptions.set(tokenId, {
                    onNewTransaction,
                    timeout: null,
                    expiry: null
                });

                this.logger.log(`[Token WS] ✅ Subscribed to Token ${tokenId}. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
            },
            tokenId,
            'Token WebSocket subscription'
        );
    }

    unsubscribeAddress(address: string): void {
        const subscription = this.addressSubscriptions.get(address);
        if (subscription) {
            if (this.addressWs) {
                this.addressWs.unsubscribeFromAddress(address);
            }
            
            // Clear timeout if exists
            if (subscription.timeout) {
                clearTimeout(subscription.timeout);
            }
            
            this.addressSubscriptions.delete(address);
            this.logger.log(`[Address WS] Unsubscribed from ${address}. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
            
            // Close WebSocket instance if no more address subscriptions
            if (this.addressSubscriptions.size === 0 && this.addressWs) {
                this.addressWs.close();
                this.addressWs = null;
                this.logger.log('[Address WS] Closed address WebSocket instance (no more subscriptions)');
            }
        }
    }

    unsubscribeToken(tokenId: string): void {
        const subscription = this.tokenSubscriptions.get(tokenId);
        if (subscription) {
            if (this.tokenWs) {
                this.tokenWs.unsubscribeFromTokenId(tokenId);
            }
            
            // Clear timeout if exists
            if (subscription.timeout) {
                clearTimeout(subscription.timeout);
            }
            
            this.tokenSubscriptions.delete(tokenId);
            this.logger.log(`[Token WS] Unsubscribed from token ${tokenId}. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
            
            // Close WebSocket instance if no more token subscriptions
            if (this.tokenSubscriptions.size === 0 && this.tokenWs) {
                this.tokenWs.close();
                this.tokenWs = null;
                this.logger.log('[Token WS] Closed token WebSocket instance (no more subscriptions)');
            }
        }
    }

    unsubscribeAll(): void {
        // Unsubscribe all addresses
        for (const address of this.addressSubscriptions.keys()) {
            this.unsubscribeAddress(address);
        }
        
        // Unsubscribe all tokens
        for (const tokenId of this.tokenSubscriptions.keys()) {
            this.unsubscribeToken(tokenId);
        }
        
        this.logger.log(`[WS] Unsubscribed from all. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
    }

    resetWsTimer(
        identifier: string, 
        options: { isToken?: boolean } = {}, 
        onTimeout: ((identifier: string) => void) | null = null
    ): void {
        const { isToken = false } = options;
        const subscriptions = isToken ? this.tokenSubscriptions : this.addressSubscriptions;
        const subscription = subscriptions.get(identifier);
        
        if (!subscription) {
            this.logger.log(`[WS] No subscription found for ${isToken ? 'token' : 'address'} ${identifier}`);
            return;
        }

        const currentTime = Date.now();
        let newExpirationTime: number;
        
        if (subscription.timeout) {
            const currentExpiration = subscription.expiry!;
            newExpirationTime = currentExpiration + this.wsExtendTimeout;
            clearTimeout(subscription.timeout);
        } else {
            newExpirationTime = currentTime + this.wsTimeout;
        }

        subscription.expiry = newExpirationTime;

        const timeoutDuration = newExpirationTime - currentTime;
        const MAX_SET_TIMEOUT = 1296000000; // 15天的最大超时时间（毫秒）
        const effectiveTimeoutDuration = Math.min(timeoutDuration, MAX_SET_TIMEOUT);

        const timeout = setTimeout(() => {
            if (isToken) {
                this.unsubscribeToken(identifier);
            } else {
                this.unsubscribeAddress(identifier);
            }
            if (onTimeout) onTimeout(identifier);
            this.logger.log(`WebSocket subscription for ${isToken ? 'Token ' : ''}${identifier} expired after ${Math.round(effectiveTimeoutDuration / 1000)}s`);
        }, effectiveTimeoutDuration);

        subscription.timeout = timeout;
    }

    getRemainingTime(identifier: string, options: { isToken?: boolean } = {}): { active: boolean; remainingSec?: number; message?: string } {
        const { isToken = false } = options;
        const subscriptions = isToken ? this.tokenSubscriptions : this.addressSubscriptions;
        const subscription = subscriptions.get(identifier);
        
        if (!subscription || !subscription.expiry) {
            return { active: false, message: 'No active WebSocket subscription timer.' };
        }
        
        const remainMs = subscription.expiry - Date.now();
        if (remainMs <= 0) {
            return { active: false, message: 'WebSocket subscription timer already expired.' };
        }
        
        const remainSec = Math.round(remainMs / 1000);
        return { active: true, remainingSec: remainSec };
    }

    private _evictOldestAddressSubscription(): void {
        const oldestAddress = this.addressSubscriptions.keys().next().value;
        if (!oldestAddress) return;
        
        this.unsubscribeAddress(oldestAddress);
        this.logger.log(`[Address WS] Evicted oldest subscription: ${oldestAddress}. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
        
        if (this.onEvict && typeof this.onEvict === 'function') {
            this.onEvict(oldestAddress, 'address');
        }
    }

    private _evictOldestTokenSubscription(): void {
        const oldestTokenId = this.tokenSubscriptions.keys().next().value;
        if (!oldestTokenId) return;
        
        this.unsubscribeToken(oldestTokenId);
        this.logger.log(`[Token WS] Evicted oldest subscription: ${oldestTokenId}. Instances: ${this._getInstanceCount()}, Subscriptions: ${this._getSubscriptionCount()}`);
        
        if (this.onEvict && typeof this.onEvict === 'function') {
            this.onEvict(oldestTokenId, 'token');
        }
    }

    private _getInstanceCount(): number {
        let count = 0;
        if (this.addressWs && !this.addressWs.manuallyClosed) count++;
        if (this.tokenWs && !this.tokenWs.manuallyClosed) count++;
        return count;
    }

    private _getSubscriptionCount(): number {
        return this.addressSubscriptions.size + this.tokenSubscriptions.size;
    }

    // For backward compatibility, keep the old getRemainingTime method signature
    getRemainingTimeForAddress(address: string): { active: boolean; remainingSec?: number; message?: string } {
        return this.getRemainingTime(address, { isToken: false });
    }
} 
