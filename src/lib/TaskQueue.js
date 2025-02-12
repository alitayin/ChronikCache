// TaskQueue: Global queue to limit concurrency
class TaskQueue {
    constructor(concurrentLimit = 2) {
        // 设置最大并发数
        this.concurrentLimit = concurrentLimit;
        this.running = 0;
        this.queue = [];
    }

    // 将任务加入队列，任务为返回 Promise 的函数
    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.dequeue();
        });
    }

    // 检查队列，若未达到并发限制则取出任务执行
    dequeue() {
        if (this.running >= this.concurrentLimit) {
            return;
        }
        if (this.queue.length === 0) {
            return;
        }
        const { task, resolve, reject } = this.queue.shift();
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

    // 获取当前等待执行的任务数
    getQueueLength() {
        return this.queue.length;
    }
}

module.exports = TaskQueue; 