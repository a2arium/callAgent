import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskEngine } from '../../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../../src/orchestration/InMemorySessionManager.js';
import { TaskExecutor } from '../../src/orchestration/TaskExecutor.js';
import { PluginManager } from '../../src/plugin/pluginManager.js';
import { globalA2AService } from '../../src/orchestration/A2AService.js';
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

const createAsyncOnlyDriver = (): RuntimeDriver => ({
    enqueueStart: jest.fn(async () => undefined),
    enqueueResume: jest.fn(async () => undefined),
    enqueueChildDispatch: jest.fn(async () => undefined),
    scheduleTimer: jest.fn(async () => ({ timerId: 'timer-1' })),
    cancel: jest.fn(async () => undefined),
    dispatchOutbox: jest.fn(async () => undefined),
});

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

        const asyncOnlyDriver = createAsyncOnlyDriver();

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

    it('persists task.failed when async start scheduling fails before a turn runs', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'start';
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver = createAsyncOnlyDriver();
        jest.mocked(runtimeDriver.enqueueStart).mockRejectedValue(new Error('provider enqueue failed'));
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver,
        });

        const result = await engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: false,
            task: {
                id: 't-start-fail',
                input: { x: 1 },
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        });

        expect(result.status?.state).toBe('failed');
        expect(runtimeDriver.enqueueStart).toHaveBeenCalledTimes(1);
        expect(executeTurnSpy).not.toHaveBeenCalled();
        const events = await store.listEventsSince({
            tenantId: 't',
            sessionId: 't-start-fail',
            sinceSeq: -1,
        });
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'task.started',
            'task.failed',
        ]));
        expect(events.find((event) => event.type === 'task.failed')?.payload).toEqual(expect.objectContaining({
            taskId: 't-start-fail',
            error: 'provider enqueue failed',
        }));

        executeTurnSpy.mockRestore();
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
        const runtimeDriver = createAsyncOnlyDriver();
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

    it('routes input resume through the runtime driver when resume surface is enabled', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'resume';
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver = createAsyncOnlyDriver();
        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 'input-task',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: { agentId: 'driver-test-agent', turn: 1 },
                pending: {
                    inputs: {
                        'input-token': { schema: { type: 'object' } },
                    },
                },
                inbox: { current: [], all: [] },
                M: initialM({ task: { id: 'input-task', input: {} } } as TaskContext),
            },
        });
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver });

        await expect(engine.resumeInput({
            tenantId: 't',
            taskId: 'input-task',
            token: 'input-token',
            input: { answer: 42 },
        })).resolves.toEqual({ acknowledged: true });

        expect(runtimeDriver.enqueueResume).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 't',
            taskId: 'input-task',
            agentId: 'driver-test-agent',
            idempotencyKey: 'input-task:input:input-token',
            event: {
                kind: 'input',
                token: 'input-token',
                value: { answer: 42 },
            },
        }));
        expect(executeTurnSpy).not.toHaveBeenCalled();

        executeTurnSpy.mockRestore();
    });

    it('routes tool completion through the runtime driver when resume surface is enabled', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'resume';
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver = createAsyncOnlyDriver();
        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 'tool-task',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: { agentId: 'driver-test-agent', turn: 1 },
                pending: {
                    tools: {
                        'tool-token': { name: 'search', args: { q: 'hi' } },
                    },
                },
                inbox: { current: [], all: [] },
                M: initialM({ task: { id: 'tool-task', input: {} } } as TaskContext),
            },
        });
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver });

        await engine.handleToolCompleted({
            tenantId: 't',
            taskId: 'tool-task',
            token: 'tool-token',
            result: { hits: 2 },
        });

        expect(runtimeDriver.enqueueResume).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 't',
            taskId: 'tool-task',
            agentId: 'driver-test-agent',
            idempotencyKey: 'tool-task:tool:tool-token',
            event: {
                kind: 'tool',
                token: 'tool-token',
                result: { hits: 2 },
            },
        }));
        expect(executeTurnSpy).not.toHaveBeenCalled();

        executeTurnSpy.mockRestore();
    });

    it('routes external event wake through the runtime driver when resume surface is enabled', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'resume';
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver = createAsyncOnlyDriver();
        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 'external-task',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: { agentId: 'driver-test-agent', turn: 1 },
                pending: {
                    events: {
                        'event-token': { type: 'webhook.received' },
                    },
                },
                inbox: { current: [], all: [] },
                M: initialM({ task: { id: 'external-task', input: {} } } as TaskContext),
            },
        });
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver });

        await engine.handleExternalEventOccurred({
            tenantId: 't',
            taskId: 'external-task',
            token: 'event-token',
            payload: { ok: true },
        });

        expect(runtimeDriver.enqueueResume).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 't',
            taskId: 'external-task',
            agentId: 'driver-test-agent',
            idempotencyKey: 'external-task:external:event-token',
            event: {
                kind: 'external',
                token: 'event-token',
                type: 'webhook.received',
                data: { ok: true },
            },
        }));
        expect(executeTurnSpy).not.toHaveBeenCalled();
        const snap = await store.getSessionSnapshot('t', 'external-task');
        expect((snap?.snapshot as any)?.pending?.events?.['event-token']).toEqual({
            type: 'webhook.received',
        });

        executeTurnSpy.mockRestore();
    });

    it('routes conversation activation through the runtime driver when resume surface is enabled', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'resume';
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver = createAsyncOnlyDriver();
        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 'thread-1:driver-test-agent',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: { agentId: 'driver-test-agent', turn: 1 },
                inbox: { current: [], all: [] },
                M: initialM({ task: { id: 'thread-1:driver-test-agent', input: {} } } as TaskContext),
            },
        });
        jest.spyOn(globalA2AService, 'findLocalAgent').mockResolvedValue(loopAgentPlugin as never);
        jest.spyOn(globalA2AService, 'buildPassiveConversationContext').mockResolvedValue({
            task: { id: 'thread-1:driver-test-agent', input: { __conversationSession: true } },
            tenantId: 't',
            agentId: 'driver-test-agent',
            memory: {},
            vars: {},
            reply: jest.fn(),
            progress: jest.fn(),
            logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
        } as never);
        const engine = new TaskEngine({ sessionStore: store, runtimeDriver });

        await expect(engine.ensureConversationActivation({
            kind: 'thread',
            tenantId: 't',
            threadId: 'thread-1',
            routingSessionId: 'thread-1:driver-test-agent',
            recipientAgentId: 'driver-test-agent',
            messageId: 'message-1',
            senderSessionId: 'sender-task',
            senderAgentId: 'sender-agent',
        })).resolves.toEqual({ ok: true });

        expect(runtimeDriver.enqueueResume).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 't',
            taskId: 'thread-1:driver-test-agent',
            agentId: 'driver-test-agent',
            idempotencyKey: 'thread-1:driver-test-agent:conversation:thread',
            event: {
                kind: 'conversation',
                token: 'thread-1:driver-test-agent',
                messageId: 'thread-1:driver-test-agent',
                data: { kind: 'message.received' },
            },
        }));
        expect(executeTurnSpy).not.toHaveBeenCalled();

        executeTurnSpy.mockRestore();
    });
});
