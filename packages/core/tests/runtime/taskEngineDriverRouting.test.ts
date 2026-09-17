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
import { StreamTransport } from '../../src/runner/StreamTransport.js';
import { setPendingInputs } from '../../src/orchestration/DurableHandlerRegistry.js';

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
        jest.spyOn(PluginManager, 'findAgent').mockReturnValue(loopAgentPlugin as never);
    });

    afterEach(() => {
        delete process.env.DISABLE_OUTBOX_PUBLISHER;
        jest.restoreAllMocks();
    });

    it('never falls through to TurnRunner when a runtime driver lacks sync extensions', async () => {
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

        expect(asyncOnlyDriver.enqueueStart).toHaveBeenCalledTimes(1);
        expect(runTurnSpy).not.toHaveBeenCalled();
        expect(executeTurnSpy).not.toHaveBeenCalled();
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
        const persisted = await store.getSessionSnapshot('t', 't-sync');
        expect((persisted?.snapshot as any)?.meta?.replyDeliveryMode).toBe('buffer');
        executeTurnSpy.mockRestore();
        startSpy.mockRestore();
    });

    it('persists streaming reply delivery before the first segment runs', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn').mockResolvedValue({
            M: initialM({ task: { id: 't-stream-mode', input: {} } } as TaskContext),
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

        await engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: true,
            task: { id: 't-stream-mode', input: {} },
        });

        const persisted = await store.getSessionSnapshot('t', 't-stream-mode');
        expect((persisted?.snapshot as any)?.meta?.replyDeliveryMode).toBe('stream');
        executeTurnSpy.mockRestore();
    });

    it('reconciles simultaneous identical reply-delivery declarations', async () => {
        const store = new InMemorySessionManager();
        const driver = createAsyncOnlyDriver();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver: driver,
        });
        const start = () => engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: true,
            task: { id: 't-concurrent-stream-mode', input: {} },
        });

        await expect(Promise.all([start(), start()])).resolves.toHaveLength(2);

        const persisted = await store.getSessionSnapshot('t', 't-concurrent-stream-mode');
        expect((persisted?.snapshot as any)?.meta?.replyDeliveryMode).toBe('stream');
    });

    it('seeds streaming mode for a valid historical input resume before enqueue', async () => {
        const store = new InMemorySessionManager();
        const driver = createAsyncOnlyDriver();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver: driver,
        });
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 't-historical-stream',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: setPendingInputs(
                { meta: { agentId: 'driver-test-agent' } },
                { 'input-token': {} }
            ),
        });

        await engine.resumeInput({
            tenantId: 't',
            taskId: 't-historical-stream',
            token: 'input-token',
            input: { text: 'answer' },
            isStreaming: true,
        });

        const persisted = await store.getSessionSnapshot('t', 't-historical-stream');
        expect((persisted?.snapshot as any)?.meta?.replyDeliveryMode).toBe('stream');
        expect(driver.enqueueResume).toHaveBeenCalledTimes(1);
    });

    it('rejects changing reply delivery mode for a live task', async () => {
        const store = new InMemorySessionManager();
        const driver = createAsyncOnlyDriver();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver: driver,
        });
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 't-buffered-live',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: setPendingInputs(
                {
                    meta: {
                        agentId: 'driver-test-agent',
                        replyDeliveryMode: 'buffer',
                    },
                },
                { 'input-token': {} }
            ),
        });

        await expect(engine.resumeInput({
            tenantId: 't',
            taskId: 't-buffered-live',
            token: 'input-token',
            input: { text: 'answer' },
            isStreaming: true,
        })).rejects.toMatchObject({
            code: 'TASK_REPLY_DELIVERY_MODE_CONFLICT',
        });
        expect(driver.enqueueResume).not.toHaveBeenCalled();
    });

    it('does not rewrite or conflict with delivery mode during terminal replay', async () => {
        const store = new InMemorySessionManager();
        const driver = createAsyncOnlyDriver();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver: driver,
        });
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 't-buffered-terminal',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: setPendingInputs(
                {
                    meta: {
                        agentId: 'driver-test-agent',
                        replyDeliveryMode: 'buffer',
                        taskLifecycle: {
                            taskId: 't-buffered-terminal',
                            rootTaskId: 't-buffered-terminal',
                            ancestorTaskIds: [],
                            state: 'completed',
                        },
                    },
                },
                { 'input-token': {} }
            ),
        });

        await expect(engine.resumeInput({
            tenantId: 't',
            taskId: 't-buffered-terminal',
            token: 'input-token',
            input: { text: 'late answer' },
            isStreaming: true,
        })).resolves.toEqual({ acknowledged: true });

        const persisted = await store.getSessionSnapshot('t', 't-buffered-terminal');
        expect((persisted?.snapshot as any)?.meta?.replyDeliveryMode).toBe('buffer');
        expect(driver.enqueueResume).toHaveBeenCalledTimes(1);
    });

    it('persists and publishes a failed terminal result returned by the sync driver', async () => {
        const failedStatus = {
            state: 'failed' as const,
            timestamp: new Date().toISOString(),
            message: {
                role: 'agent' as const,
                parts: [{ type: 'text' as const, text: 'Loop failed: budget_turns_exceeded' }],
            },
            metadata: { reason: 'budget_turns_exceeded' },
        };
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn').mockResolvedValue({
            M: initialM({ task: { id: 't-budget-fail', input: {} } } as TaskContext),
            outcome: { kind: 'fail', reason: 'budget_turns_exceeded' },
            metrics: {},
            taskStatus: failedStatus,
        });

        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        const detachSpy = jest
            .spyOn(engine as unknown as { detachTaskBranch: (...args: any[]) => Promise<unknown> }, 'detachTaskBranch')
            .mockResolvedValue([]);
        const result = await engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: false,
            task: {
                id: 't-budget-fail',
                input: {},
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        });

        expect(result?.status?.state).toBe('failed');
        const events = await store.listEventsSince({
            tenantId: 't',
            sessionId: 't-budget-fail',
            sinceSeq: -1,
        });
        expect(events.map((event) => event.type)).toContain('task.failed');
        expect(events.find((event) => event.type === 'task.failed')?.payload).toEqual(
            expect.objectContaining({
                taskId: 't-budget-fail',
                reason: 'budget_turns_exceeded',
                error: 'Loop failed: budget_turns_exceeded',
            })
        );

        const outbox = (store as unknown as {
            outbox: Array<{ topic: string; key: string; payload: Record<string, unknown> }>;
        }).outbox;
        expect(outbox).toContainEqual(expect.objectContaining({
            topic: 'task.status',
            key: 't-budget-fail',
            payload: expect.objectContaining({
                final: true,
                status: failedStatus,
            }),
        }));

        executeTurnSpy.mockRestore();
        detachSpy.mockRestore();
    });

    it('keeps budget exhaustion visible in the console transport', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const transport = new StreamTransport({ outputType: 'console' });
        const status = {
            state: 'failed' as const,
            timestamp: '2023-01-01',
            metadata: { reason: 'budget_turns_exceeded' },
            message: {
                role: 'agent' as const,
                parts: [{ type: 'text' as const, text: 'Loop failed: budget_turns_exceeded' }],
            },
        };

        transport.handleStatus(status, true);

        expect(consoleSpy).toHaveBeenCalledWith('Status: failed (FINAL)');
        expect(consoleSpy).toHaveBeenCalledWith('Loop outcome: kind: fail');
        expect(consoleSpy).toHaveBeenCalledWith('Message: Loop failed: budget_turns_exceeded');
        consoleSpy.mockRestore();
    });

    it('propagates async start scheduling failure without synthesizing an unfenced terminal', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver = createAsyncOnlyDriver();
        jest.mocked(runtimeDriver.enqueueStart).mockRejectedValue(new Error('provider enqueue failed'));
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({
            sessionStore: store,
            runtimeDriver,
        });

        await expect(engine.startTask({
            tenantId: 't',
            agentId: 'driver-test-agent',
            isStreaming: false,
            task: {
                id: 't-start-fail',
                input: { x: 1 },
                status: { state: 'submitted', timestamp: new Date().toISOString() },
            },
        })).rejects.toThrow('provider enqueue failed');

        expect(runtimeDriver.enqueueStart).toHaveBeenCalledTimes(1);
        expect(executeTurnSpy).not.toHaveBeenCalled();
        const events = await store.listEventsSince({
            tenantId: 't',
            sessionId: 't-start-fail',
            sinceSeq: -1,
        });
        expect(events.map((event) => event.type)).toContain('task.started');
        expect(events.map((event) => event.type)).not.toContain('task.failed');

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

    it('routes child completion through the configured runtime driver', async () => {
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
                    turnCoordinator: {
                        schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                        requestedGeneration: '0', completedGeneration: '0',
                    },
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
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver = createAsyncOnlyDriver();
        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 'input-task',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    agentId: 'driver-test-agent', turn: 1,
                    turnCoordinator: {
                        schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                        requestedGeneration: '0', completedGeneration: '0',
                    },
                },
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
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
        const runtimeDriver = createAsyncOnlyDriver();
        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 't',
            sessionId: 'tool-task',
            agentId: 'driver-test-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    agentId: 'driver-test-agent', turn: 1,
                    turnCoordinator: {
                        schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                        requestedGeneration: '0', completedGeneration: '0',
                    },
                },
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
