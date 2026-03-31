const assert = require('node:assert/strict');
const TaskQueue = require('../../src/lib/TaskQueue').default;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('TaskQueue', () => {
    it('processes queued tasks and resolves results', async () => {
        const queue = new TaskQueue(1);
        const result = await Promise.all([
            queue.enqueue(async () => 'a'),
            queue.enqueue(async () => 'b'),
        ]);

        assert.deepStrictEqual(result, ['a', 'b']);
    });

    it('enforces the configured concurrency limit', async () => {
        const queue = new TaskQueue(2);
        let running = 0;
        let maxRunning = 0;

        await Promise.all(
            [1, 2, 3, 4].map(i =>
                queue.enqueue(async () => {
                    running += 1;
                    maxRunning = Math.max(maxRunning, running);
                    await sleep(10);
                    running -= 1;
                    return i;
                }),
            ),
        );

        assert.equal(maxRunning, 2);
        assert.equal(queue.getQueueLength(), 0);
    });
});
