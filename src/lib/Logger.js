class Logger {
    constructor(enableLogging = false) {
        this.enableLogging = enableLogging;
    }

    log(...args) {
        if (this.enableLogging) {
            console.log(...args);
        }
    }

    error(...args) {
        if (this.enableLogging) {
            console.error(...args);
        }
    }
}

module.exports = Logger; 