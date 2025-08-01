// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

export default class Logger {
    private enableLogging: boolean;
    private enableTimer: boolean;
    private timers: Map<string, [number, number]>;

    constructor(enableLogging: boolean = false, enableTimer: boolean = false) {
        this.enableLogging = enableLogging;
        this.enableTimer = enableTimer;
        this.timers = new Map();
    }

    log(...args: any[]): void {
        if (this.enableLogging) {
            console.log(new Date().toISOString(), ...args);
        }
    }

    error(...args: any[]): void {
        if (this.enableLogging) {
            console.error(new Date().toISOString(), ...args);
        }
    }

    startTimer(label: string): void {
        if (!this.enableTimer) return;
        this.timers.set(label, process.hrtime());
    }

    endTimer(label: string): void {
        if (!this.enableTimer) return;
        const startTime = this.timers.get(label);
        if (!startTime) return;
        const diff = process.hrtime(startTime);
        const elapsed = diff[0] * 1000 + diff[1] / 1e6;
        this.log(`${label} timer ended: ${elapsed} ms`);
        this.timers.delete(label);
    }
} 
