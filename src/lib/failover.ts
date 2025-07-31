// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

import Logger from './Logger';

interface FailoverOptions {
    maxRetries?: number;
    retryDelay?: number;
    exponentialBackoff?: boolean;
    enableLogging?: boolean;
}

export default class FailoverHandler {
    private maxRetries: number;
    private retryDelay: number;
    private exponentialBackoff: boolean;
    private enableLogging: boolean;
    private logger: Logger;

    constructor(options: FailoverOptions = {}) {
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 1500; // milliseconds
        this.exponentialBackoff = options.exponentialBackoff || true;
        this.enableLogging = options.enableLogging || false;
        this.logger = new Logger(this.enableLogging);
    }

    async executeWithRetry<T>(operation: () => Promise<T>, context: string = ''): Promise<T> {
        let lastError: Error;
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error as Error;
                const delay = this.exponentialBackoff 
                    ? this.retryDelay * Math.pow(2, attempt - 1)
                    : this.retryDelay;

                this.logger.error(`[Failover] ${context} - Attempt ${attempt}/${this.maxRetries} failed:`, lastError.message);
                
                if (attempt < this.maxRetries) {
                    this.logger.log(`[Failover] Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        this.logger.error(`[Failover] ${context} - All retry attempts failed`);
        throw lastError!;
    }

    /**
     * Special handling for WebSocket related operations
     */
    async handleWebSocketOperation<T>(operation: () => Promise<T>, address: string, context: string = ''): Promise<T> {
        try {
            return await this.executeWithRetry(operation, context);
        } catch (error) {
            const err = error as any;
            this.logger.error(`[Failover] WebSocket operation failed for address ${address}:`, err.message);
            // WebSocket specific error handling logic
            if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
                this.logger.log(`[Failover] WebSocket connection issue detected for ${address}`);
            }
            throw error;
        }
    }

    /**
     * Special handling for database operations
     */
    async handleDbOperation<T>(operation: () => Promise<T>, context: string = ''): Promise<T | null> {
        try {
            return await this.executeWithRetry(operation, context);
        } catch (error) {
            const err = error as any;
            this.logger.error(`[Failover] Database operation failed:`, err.message);
            // Database specific error handling logic
            if (err.type === 'NotFoundError') {
                return null;
            }
            throw error;
        }
    }
} 
