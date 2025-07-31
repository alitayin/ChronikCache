// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

interface QueueItem<T> {
    task: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
}

/**
 * TaskQueue: Global queue to limit concurrency
 */
export default class TaskQueue {
    private concurrentLimit: number;
    private running: number;
    private queue: QueueItem<any>[];

    constructor(concurrentLimit: number = 2) {
        // 设置最大并发数
        this.concurrentLimit = concurrentLimit;
        this.running = 0;
        this.queue = [];
    }

    /**
     * 将任务加入队列，任务为返回 Promise 的函数
     */
    enqueue<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.dequeue();
        });
    }

    /**
     * 检查队列，若未达到并发限制则取出任务执行
     */
    private dequeue(): void {
        if (this.running >= this.concurrentLimit) {
            return;
        }
        if (this.queue.length === 0) {
            return;
        }
        const { task, resolve, reject } = this.queue.shift()!;
        this.running++;
        task()
            .then(result => {
                resolve(result);
            })
            .catch(error => {
                reject(error);
            })
            .finally(() => {
                this.running--;
                this.dequeue();
            });
    }

    /**
     * 获取当前等待执行的任务数
     */
    getQueueLength(): number {
        return this.queue.length;
    }
} 
