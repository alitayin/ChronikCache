class Logger {
    constructor(enableLogging = false) {
        this.enableLogging = enableLogging;
        this.timers = new Map();
    }

    log(...args) {
        if (this.enableLogging) {
            console.log(new Date().toISOString(), ...args);
        }
    }

    error(...args) {
        if (this.enableLogging) {
            console.error(new Date().toISOString(), ...args);
        }
    }

    startTimer(label) {
        this.timers.set(label, Date.now());
        this.log(`${label} timer started`);
    }

    endTimer(label) {
        if (this.timers.has(label)) {
            const elapsed = Date.now() - this.timers.get(label);
            this.log(`${label} timer ended: ${elapsed} ms`);
            this.timers.delete(label);
        } else {
            this.log(`${label} timer not found`);
        }
    }
}

module.exports = Logger; 