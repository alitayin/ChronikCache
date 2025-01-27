const Logger = require('./Logger');

class FailoverHandler {
    constructor(options = {}) {
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 1000; // milliseconds
        this.exponentialBackoff = options.exponentialBackoff || true;
        this.enableLogging = options.enableLogging || false;
        this.logger = new Logger(this.enableLogging);
    }

    async executeWithRetry(operation, context = '') {
        let lastError;
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                const delay = this.exponentialBackoff 
                    ? this.retryDelay * Math.pow(2, attempt - 1)
                    : this.retryDelay;

                this.logger.error(`[Failover] ${context} - Attempt ${attempt}/${this.maxRetries} failed:`, error.message);
                
                if (attempt < this.maxRetries) {
                    this.logger.log(`[Failover] Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        this.logger.error(`[Failover] ${context} - All retry attempts failed`);
        throw lastError;
    }

    // Special handling for WebSocket related operations
    async handleWebSocketOperation(operation, address, context = '') {
        try {
            return await this.executeWithRetry(operation, context);
        } catch (error) {
            this.logger.error(`[Failover] WebSocket operation failed for address ${address}:`, error.message);
            // WebSocket specific error handling logic
            if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
                this.logger.log(`[Failover] WebSocket connection issue detected for ${address}`);
            }
            throw error;
        }
    }

    // Special handling for database operations
    async handleDbOperation(operation, context = '') {
        try {
            return await this.executeWithRetry(operation, context);
        } catch (error) {
            this.logger.error(`[Failover] Database operation failed:`, error.message);
            // Database specific error handling logic
            if (error.type === 'NotFoundError') {
                return null;
            }
            throw error;
        }
    }
}

module.exports = FailoverHandler;
