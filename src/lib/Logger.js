class Logger {
    constructor(enableLogging, enableTimer = false) {
        this.enableLogging = enableLogging;
        this.enableTimer = enableTimer;
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
        if (!this.enableTimer) return;
        this.timers.set(label, process.hrtime());
    }

    endTimer(label) {
        if (!this.enableTimer) return;
        const startTime = this.timers.get(label);
        if (!startTime) return;
        const diff = process.hrtime(startTime);
        const elapsed = diff[0] * 1000 + diff[1] / 1e6;
        this.log(`${label} timer ended: ${elapsed} ms`);
        this.timers.delete(label);
    }
}

module.exports = Logger; 