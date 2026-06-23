import { describe, it, expect, beforeEach } from '@jest/globals';
import {
    InProcessRuntimeDriver,
    wakeEventToTurnWake,
    type TimerScheduler,
} from '../../src/runtime/inProcessRuntimeDriver.js';
import type {
    RunSegmentParams,
    SegmentResult,
    TurnExecutor,
} from '../../src/runtime/turnExecutor.js';
import type { RuntimeWakeEvent } from '../../src/runtime/runtimeDriver.js';

function makeFakeExecutor(
    impl?: (params: RunSegmentParams) => Promise<SegmentResult>
): { executor: TurnExecutor; calls: RunSegmentParams[] } {
    const calls: RunSegmentParams[] = [];
    const executor: TurnExecutor = {
        async runSegment(params) {
            calls.push(params);
            if (impl) {
                return impl(params);
            }
            return {
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId,
                boundary: { kind: 'complete' },
                taskStatus: 'completed',
            };
        },
    };
    return { executor, calls };
}

type ManualScheduler = TimerScheduler & {
    fireAll(): void;
    pending(): number;
};

function makeManualScheduler(): ManualScheduler {
    const jobs = new Map<number, { cb: () => void }>();
    let seq = 0;
    return {
        set(cb) {
            const id = ++seq;
            jobs.set(id, { cb });
            return id;
        },
        clear(handle) {
            jobs.delete(handle as number);
        },
        fireAll() {
            for (const [id, job] of [...jobs.entries()]) {
                jobs.delete(id);
                job.cb();
            }
        },
        pending() {
            return jobs.size;
        },
    };
}

const ids = {
    tenantId: 't1',
    taskId: 'task-1',
    agentId: 'agent-1',
    idempotencyKey: 'idem-1',
};

describe('wakeEventToTurnWake', () => {
    it('maps every wake event kind to the expected trigger', () => {
        const cases: Array<[RuntimeWakeEvent, string]> = [
            [{ kind: 'input', token: 't', value: 1 }, 'resume'],
            [{ kind: 'tool', token: 't', result: 1 }, 'tool'],
            [{ kind: 'child', token: 't', childTaskId: 'c', output: 1 }, 'child'],
            [{
                kind: 'timer',
                token: 't',
                timerId: 'tm',
                dueAt: '2026-06-23T00:00:00.000Z',
                firedAt: '2026-06-23T00:00:01.000Z',
                reason: 'input_timeout',
            }, 'timer'],
            [{ kind: 'external', token: 't', type: 'x', data: 1 }, 'event'],
            [{ kind: 'conversation', token: 't', messageId: 'm', data: 1 }, 'conversation'],
        ];
        for (const [event, trigger] of cases) {
            expect(wakeEventToTurnWake(event).trigger).toBe(trigger);
        }
    });
});

describe('InProcessRuntimeDriver', () => {
    let scheduler: ManualScheduler;

    beforeEach(() => {
        scheduler = makeManualScheduler();
    });

    it('runs a start segment immediately as tracked background work', async () => {
        const { executor, calls } = makeFakeExecutor();
        const driver = new InProcessRuntimeDriver({ turnExecutor: executor, scheduler });

        await driver.enqueueStart({ ...ids, input: { hello: 'world' } });

        // runSegment is invoked synchronously when scheduled.
        expect(calls).toHaveLength(1);
        expect(calls[0].wake).toEqual({ trigger: 'start', input: { hello: 'world' } });
        expect(calls[0].idempotencyKey).toBe('idem-1');

        await driver.waitForIdle();
    });

    it('maps a resume wake event to the kernel trigger', async () => {
        const { executor, calls } = makeFakeExecutor();
        const driver = new InProcessRuntimeDriver({ turnExecutor: executor, scheduler });

        await driver.enqueueResume({
            ...ids,
            event: { kind: 'tool', token: 'tok-9', result: { ok: true } },
        });
        await driver.waitForIdle();

        expect(calls).toHaveLength(1);
        expect(calls[0].wake).toEqual({
            trigger: 'tool',
            event: { kind: 'tool', token: 'tok-9', result: { ok: true } },
        });
    });

    it('routes a background segment rejection to onSegmentError', async () => {
        const { executor } = makeFakeExecutor(async () => {
            throw new Error('segment boom');
        });
        const errors: unknown[] = [];
        const driver = new InProcessRuntimeDriver({
            turnExecutor: executor,
            scheduler,
            onSegmentError: (error) => errors.push(error),
        });

        await driver.enqueueStart({ ...ids, input: {} });
        await driver.waitForIdle();

        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('segment boom');
    });

    it('fires a scheduled timer as a timer resume with a derived idempotency key', async () => {
        const { executor, calls } = makeFakeExecutor();
        const driver = new InProcessRuntimeDriver({
            turnExecutor: executor,
            scheduler,
            now: () => 0,
        });

        const { timerId } = await driver.scheduleTimer({
            ...ids,
            token: 'tok-timer',
            fireAt: new Date(1000).toISOString(),
            kind: 'token_expiry',
            payload: { n: 1 },
        });
        expect(scheduler.pending()).toBe(1);
        expect(calls).toHaveLength(0);

        scheduler.fireAll();
        await driver.waitForIdle();

        expect(calls).toHaveLength(1);
        expect(calls[0].wake).toEqual({
            trigger: 'timer',
            event: {
                kind: 'timer',
                token: 'tok-timer',
                timerId,
                dueAt: new Date(1000).toISOString(),
                firedAt: new Date(0).toISOString(),
                reason: 'input_timeout',
                payload: { n: 1 },
            },
        });
        expect(calls[0].idempotencyKey).toBe(`timer:t1:task-1:tok-timer:${timerId}`);
    });

    it('cancel clears scheduled timers so they never fire', async () => {
        const { executor, calls } = makeFakeExecutor();
        const driver = new InProcessRuntimeDriver({ turnExecutor: executor, scheduler });

        await driver.scheduleTimer({
            ...ids,
            token: 'tok-timer',
            fireAt: new Date(Date.now() + 60_000).toISOString(),
            kind: 'token_expiry',
        });
        expect(scheduler.pending()).toBe(1);

        await driver.cancel({ ...ids, reason: 'user-cancel' });
        expect(scheduler.pending()).toBe(0);

        scheduler.fireAll();
        await driver.waitForIdle();
        expect(calls).toHaveLength(0);
    });

    it('cancel invokes the onCancel hook', async () => {
        const { executor } = makeFakeExecutor();
        const cancels: string[] = [];
        const driver = new InProcessRuntimeDriver({
            turnExecutor: executor,
            scheduler,
            onCancel: (params) => {
                cancels.push(params.reason);
            },
        });

        await driver.cancel({ ...ids, reason: 'stop' });
        expect(cancels).toEqual(['stop']);
    });

    it('delegates child dispatch and throws when no dispatcher is wired', async () => {
        const { executor } = makeFakeExecutor();
        const dispatched: string[] = [];
        const driver = new InProcessRuntimeDriver({
            turnExecutor: executor,
            scheduler,
            childDispatcher: async (params) => {
                dispatched.push(params.childTaskId);
            },
        });

        await driver.enqueueChildDispatch({
            ...ids,
            parentTaskId: 'task-1',
            childTaskId: 'child-1',
            childAgentId: 'agent-2',
            input: {},
        });
        expect(dispatched).toEqual(['child-1']);

        const noDispatcher = new InProcessRuntimeDriver({ turnExecutor: executor, scheduler });
        await expect(
            noDispatcher.enqueueChildDispatch({
                ...ids,
                parentTaskId: 'task-1',
                childTaskId: 'child-2',
                childAgentId: 'agent-2',
                input: {},
            })
        ).rejects.toThrow('childDispatcher');
    });

    it('dispatchOutbox delegates when provided and is a no-op otherwise', async () => {
        const { executor } = makeFakeExecutor();
        const dispatched: string[] = [];
        const driver = new InProcessRuntimeDriver({
            turnExecutor: executor,
            scheduler,
            outboxDispatcher: async (params) => {
                dispatched.push(params.outboxRowId);
            },
        });

        await driver.dispatchOutbox({ outboxRowId: 'row-1', eventType: 'task.status' });
        expect(dispatched).toEqual(['row-1']);

        const noOp = new InProcessRuntimeDriver({ turnExecutor: executor, scheduler });
        await expect(
            noOp.dispatchOutbox({ outboxRowId: 'row-2', eventType: 'task.status' })
        ).resolves.toBeUndefined();
    });
});
