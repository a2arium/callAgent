import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskEngine } from '../../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../../src/orchestration/InMemorySessionManager.js';
import { TaskExecutor } from '../../src/orchestration/TaskExecutor.js';
import { PluginManager } from '../../src/plugin/pluginManager.js';
import { isSyncRuntimeDriver } from '../../src/runtime/inProcessRuntimeDriver.js';
import type { RuntimeDriver } from '../../src/runtime/runtimeDriver.js';
import { initialM } from '../../src/loop/init.js';
import type { TaskContext } from '../../src/shared/types/index.js';

const loopAgentPlugin = {
    resolved: {
        runtimeManifest: {
            name: 'driver-test-agent',
            version: '1.0.0',
            runMode: 'loop' as const,
            budgets: { maxTurns: 5 },
        },
        agentCard: { name: 'driver-test-agent', version: '1.0.0' },
    },
};

describe('TaskEngine runtime driver routing', () => {
    beforeEach(() => {
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        delete process.env.CALLAGENT_DRIVER_SURFACES;
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue(loopAgentPlugin as never);
    });

    afterEach(() => {
        delete process.env.DISABLE_OUTBOX_PUBLISHER;
        delete process.env.CALLAGENT_DRIVER_SURFACES;
        jest.restoreAllMocks();
    });

    it('falls back to turnRunner when driver lacks sync extensions', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn').mockResolvedValue({
            M: initialM({ task: { id: 't-fallback', input: {} } } as TaskContext),
            outcome: { kind: 'complete', result: {} },
            metrics: {},
            taskStatus: { state: 'completed', timestamp: new Date().toISOString() },
        });

        const asyncOnlyDriver: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 't1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };

        const store = new InMemorySessionManager();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver: asyncOnlyDriver,
        });

        const runTurnSpy = jest.spyOn(
            (engine as { turnRunner: { runTurn: Function } }).turnRunner,
            'runTurn'
        );

        await engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: false,
            task: {
                id: 't-fallback',
                input: {},
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        });

        expect(asyncOnlyDriver.enqueueStart).not.toHaveBeenCalled();
        expect(runTurnSpy).toHaveBeenCalledTimes(1);
        executeTurnSpy.mockRestore();
        runTurnSpy.mockRestore();
    });

    it('uses sync driver extensions when available', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn').mockResolvedValue({
            M: initialM({ task: { id: 't-sync', input: {} } } as TaskContext),
            outcome: { kind: 'complete', result: { ok: true } },
            metrics: {},
            taskStatus: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: { result: { ok: true } },
            },
        });

        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        const driver = engine.getCompositionRuntimeDriver();
        expect(isSyncRuntimeDriver(driver)).toBe(true);

        const startSpy = jest.spyOn(driver, 'enqueueStartSync');

        await engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: false,
            task: {
                id: 't-sync',
                input: { x: 1 },
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        });

        expect(startSpy).toHaveBeenCalledTimes(1);
        executeTurnSpy.mockRestore();
        startSpy.mockRestore();
    });

    it('restores persisted A2A parent link before notifying a completed child', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn').mockResolvedValue({
            M: initialM({ task: { id: 'child-task', input: {} } } as TaskContext),
            outcome: { kind: 'complete', result: { ok: true } },
            metrics: {},
            taskStatus: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: { result: { ok: true } },
            },
        });

        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 'child-task',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    agentId: 'driver-test-agent',
                    a2aParent: {
                        parentTenantId: 't',
                        parentTaskId: 'parent-task',
                        parentChildToken: 'child-token',
                    },
                },
                M: initialM({ task: { id: 'child-task', input: {} } } as TaskContext),
            },
        });

        const engine = new TaskEngine({ sessionStore: store });
        const completionSpy = jest
            .spyOn(engine, 'handleChildCompleted')
            .mockResolvedValue(true);

        await engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: false,
            task: {
                id: 'child-task',
                input: {},
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        });

        expect(completionSpy).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 't',
            parentTaskId: 'parent-task',
            childToken: 'child-token',
            childTaskId: 'child-task',
            childAgentId: 'driver-test-agent',
        }));

        executeTurnSpy.mockRestore();
        completionSpy.mockRestore();
    });

    it('routes child completion through the runtime driver when resume surface is enabled', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'resume';
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver: RuntimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 'timer-1' })),
            cancel: jest.fn(async () => undefined),
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 'parent-task',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    agentId: 'driver-test-agent',
                    awaiting: { kind: 'await_child', token: 'child-token' },
                    turn: 1,
                },
                pending: {
                    tasks: {
                        'child-token': {
                            childTaskId: 'child-task',
                            handlers: {},
                            options: { autoClearToken: true },
                        },
                    },
                },
                inbox: { current: [], all: [] },
                M: initialM({ task: { id: 'parent-task', input: {} } } as TaskContext),
            },
        });
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver,
        });

        await engine.handleChildCompleted({
            tenantId: 't',
            parentTaskId: 'parent-task',
            childToken: 'child-token',
            childTaskId: 'child-task',
            childAgentId: 'child-agent',
            result: {
                id: 'child-task',
                status: { state: 'completed', timestamp: new Date().toISOString() },
                metadata: { result: { ok: true, value: 1 } },
            },
        });

        expect(runtimeDriver.enqueueResume).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 't',
            taskId: 'parent-task',
            agentId: 'driver-test-agent',
            token: 'child-token',
            idempotencyKey: 'parent-task:child:child-token',
            event: expect.objectContaining({
                kind: 'child',
                token: 'child-token',
                childTaskId: 'child-task',
            }),
        }));
        expect(executeTurnSpy).not.toHaveBeenCalled();

        executeTurnSpy.mockRestore();
    });
});
