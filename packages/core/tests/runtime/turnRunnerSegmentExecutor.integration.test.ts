import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TurnRunnerSegmentExecutor } from '../../src/runtime/turnRunnerSegmentExecutor.js';
import { createInMemorySegmentDedupe } from '../../src/runtime/inMemorySegmentDedupe.js';
import { TurnRunner } from '../../src/orchestration/TurnRunner.js';
import { TaskExecutor } from '../../src/orchestration/TaskExecutor.js';
import { SessionManager } from '../../src/orchestration/SessionManager.js';
import { InMemorySessionManager } from '../../src/orchestration/InMemorySessionManager.js';
import { ApiBinder } from '../../src/orchestration/api/ApiBinder.js';
import { createInMemoryEventBus } from '../../src/eventbus/inMemoryEventBus.js';
import { initialM } from '../../src/loop/init.js';
import type { TaskContext } from '../../src/shared/types/index.js';
import { setPendingInputs } from '../../src/orchestration/DurableHandlerRegistry.js';
import { setPendingTools } from '../../src/orchestration/ToolsRegistry.js';
import { setPendingExternalEvents } from '../../src/orchestration/ExternalEventsRegistry.js';
import { setPendingTasks } from '../../src/orchestration/Handles.js';
import { readProcessedSegmentKeys } from '../../src/runtime/segmentProcessedKeys.js';
import { markSegmentCancellationRequested } from '../../src/runtime/segmentCancellation.js';
import { currentTaskTurnClaim } from '../../src/runtime/segmentProcessedKeys.js';
import { completeTaskTurnInSnapshot } from '../../src/orchestration/TaskTurnCoordinator.js';
import { reconcileSnapshotMutation } from '../../src/orchestration/persistence/SnapshotRepository.js';
import { ModuleExecutionError, FrameworkModule } from '../../src/utils/errors.js';
import { TaskLifecycleTerminalError } from '@a2arium/callagent-types/task-lifecycle-terminal';
import { taskChannel } from '../../src/eventbus/taskEventEmitter.js';
import type { A2AEvent } from '../../src/shared/types/StreamingEvents.js';

async function persistMockTurn(
    params: Parameters<typeof TaskExecutor.executeTurn>[0],
    result: Awaited<ReturnType<typeof TaskExecutor.executeTurn>>
) {
    const claim = currentTaskTurnClaim();
    if (!claim || !params.sessionManager) return result;
    const persisted = await reconcileSnapshotMutation({
        session: params.sessionManager,
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        operation: 'test.turn.persist',
        mutate: ({ snapshot, storageNow }) => {
            const completed = completeTaskTurnInSnapshot(snapshot, {
                tenantId: params.tenantId,
                taskId: params.sessionId,
                claim,
                storageNow,
            });
            return {
                kind: 'write' as const,
                snapshot: completed.snapshot,
                value: { scheduleNext: completed.scheduleNext },
            };
        },
    });
    (params.ctx as { __wmSavedThisTurn?: boolean }).__wmSavedThisTurn = true;
    return {
        ...result,
        persistence: {
            disposition: 'committed' as const,
            scheduleNext: persisted.value.scheduleNext,
            snapshot: persisted.snapshot,
            wmVersion: persisted.wmVersion,
        },
    };
}

function withCompletedCoordinator(snapshot: Record<string, unknown>): Record<string, unknown> {
    const meta = (snapshot.meta as Record<string, unknown> | undefined) ?? {};
    return {
        ...snapshot,
        meta: {
            ...meta,
            turnCoordinator: {
                schemaVersion: 1,
                nextFence: '1',
                nextTurnSeq: 1,
                requestedGeneration: '1',
                completedGeneration: '1',
            },
        },
    };
}

describe('TurnRunnerSegmentExecutor integration', () => {
    const tenantId = 'tenant-seg';
    const taskId = 'task-seg-1';
    const agentId = 'agent-seg';

    let store: InMemorySessionManager;
    let sessionManager: SessionManager;
    let turnRunner: TurnRunner;
    let executor: TurnRunnerSegmentExecutor;
    let executeTurnSpy: ReturnType<typeof jest.spyOn>;
    let eventBus: ReturnType<typeof createInMemoryEventBus>;

    beforeEach(() => {
        store = new InMemorySessionManager();
        sessionManager = new SessionManager(store);
        const apiBinder = {
            attachOrchestrationAPIs: jest.fn().mockResolvedValue(undefined),
        } as unknown as ApiBinder;
        eventBus = createInMemoryEventBus();
        turnRunner = new TurnRunner(sessionManager, apiBinder, () => undefined, eventBus);

        executor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task) =>
                ({
                    task,
                    logger: console,
                    progress: jest.fn(),
                    fail: jest.fn(),
                }) as TaskContext,
            dedupe: createInMemorySegmentDedupe(),
        });

        executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn');
    });

    afterEach(() => {
        executeTurnSpy.mockRestore();
    });

    it('passes authoritative tenant and agent identity into reconstructed contexts', async () => {
        const boundContexts: Array<{
            tenantId?: string;
            agentId?: string;
            abortSignal?: AbortSignal;
        }> = [];
        const boundExecutor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task, binding) => {
                boundContexts.push(binding ?? {});
                return {
                    task,
                    logger: console,
                    progress: jest.fn(),
                    fail: jest.fn(),
                } as unknown as TaskContext;
            },
            dedupe: createInMemorySegmentDedupe(),
        });
        executeTurnSpy.mockImplementation(async (params) => persistMockTurn(params, {
            M: initialM(params.ctx),
            outcome: { kind: 'complete', result: { done: true } },
            metrics: {},
            taskStatus: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: { result: { done: true } },
            },
        }));

        const runtimeAbort = new AbortController();
        runtimeAbort.abort(new Error('cancelled by Hatchet'));
        await boundExecutor.runSegment({
            tenantId,
            taskId: `${taskId}-binding`,
            agentId,
            idempotencyKey: `${taskId}-binding:start`,
            runtimeSurface: 'hatchet',
            abortSignal: runtimeAbort.signal,
            wake: { trigger: 'start', input: {} },
        });

        expect(boundContexts).toEqual([expect.objectContaining({ tenantId, agentId, abortSignal: expect.any(Object) })]);
        expect(boundContexts[0]!.abortSignal?.aborted).toBe(true);
    });

    it('enforces the admitted root deadline before acquiring the initial turn', async () => {
        const ensureInitialRootDeadline = jest.fn(async () => 'canceled' as const);
        const guardedExecutor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task) => ({
                task,
                logger: console,
                progress: jest.fn(),
                fail: jest.fn(),
            }) as TaskContext,
            dedupe: createInMemorySegmentDedupe(),
            ensureInitialRootDeadline,
        });

        const result = await guardedExecutor.runSegment({
            tenantId,
            taskId: `${taskId}-expired`,
            agentId,
            idempotencyKey: `${taskId}-expired:turn-request:1`,
            runtimeSurface: 'hatchet',
            recoveryGeneration: '1',
            wake: { trigger: 'start', input: {} },
        });

        expect(result.taskStatus).toBe('canceled');
        expect(ensureInitialRootDeadline).toHaveBeenCalledWith(expect.objectContaining({
            tenantId,
            taskId: `${taskId}-expired`,
            agentId,
            snapshot: {},
        }));
        expect(executeTurnSpy).not.toHaveBeenCalled();
        await expect(sessionManager.load(tenantId, `${taskId}-expired`)).resolves.toBeNull();
    });

    it('leaves the initial turn unclaimed when deadline timer repair is unavailable', async () => {
        const guardedExecutor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task) => ({
                task,
                logger: console,
                progress: jest.fn(),
                fail: jest.fn(),
            }) as TaskContext,
            dedupe: createInMemorySegmentDedupe(),
            ensureInitialRootDeadline: async () => {
                const error = new Error('timer unavailable');
                error.name = 'TASK_RUN_DEADLINE_UNAVAILABLE';
                throw error;
            },
        });
        const guardedTaskId = `${taskId}-timer-unavailable`;

        await expect(guardedExecutor.runSegment({
            tenantId,
            taskId: guardedTaskId,
            agentId,
            idempotencyKey: `${guardedTaskId}:turn-request:1`,
            runtimeSurface: 'hatchet',
            recoveryGeneration: '1',
            wake: { trigger: 'start', input: {} },
        })).rejects.toMatchObject({ name: 'TASK_RUN_DEADLINE_UNAVAILABLE' });

        expect(executeTurnSpy).not.toHaveBeenCalled();
        await expect(sessionManager.load(tenantId, guardedTaskId)).resolves.toBeNull();
    });

    it('rejects raw TurnRunner execution for an initialized loop task without a fence', async () => {
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: taskId,
            agentId,
            expectedWmVersion: 0n,
            snapshot: withCompletedCoordinator({ meta: { agentId }, M: {} }),
        });
        const ctx = {
            task: { id: taskId, input: {} }, logger: console,
            progress: jest.fn(), fail: jest.fn(), tenantId, agentId,
        } as unknown as TaskContext;

        await expect(turnRunner.runTurn(ctx, {
            tenantId, sessionId: taskId, trigger: 'resume', isStreaming: false,
        })).rejects.toMatchObject({ code: 'TASK_TURN_UNFENCED_EXECUTION' });
        expect(executeTurnSpy).not.toHaveBeenCalled();
    });

    it('identifies Hatchet terminal callbacks so parent delivery remains task-state owned', async () => {
        const hatchetTaskId = `${taskId}-hatchet-terminal`;
        const onTaskTerminal = jest.fn(async () => undefined);
        const hatchetExecutor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task) => ({
                task,
                logger: console,
                progress: jest.fn(),
                fail: jest.fn(),
            }) as TaskContext,
            dedupe: createInMemorySegmentDedupe(),
            onTaskTerminal,
        });
        executeTurnSpy.mockImplementation(async (params) => persistMockTurn(params, {
            M: initialM(params.ctx),
            outcome: { kind: 'complete', result: { done: true } },
            metrics: {},
            taskStatus: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: { result: { done: true } },
            },
        }));

        await hatchetExecutor.runSegment({
            tenantId,
            taskId: hatchetTaskId,
            agentId,
            idempotencyKey: `${hatchetTaskId}:start`,
            runtimeSurface: 'hatchet',
            wake: { trigger: 'start', input: {} },
        });

        expect(onTaskTerminal).toHaveBeenCalledWith({
            tenantId,
            taskId: hatchetTaskId,
            state: 'completed',
            runtimeSurface: 'hatchet',
        });
    });

    it('classifies a wrapped terminal-effect error only after durable ownership is lost', async () => {
        const supersededTaskId = `${taskId}-wrapped-superseded`;
        const turnSpy = jest.spyOn(turnRunner, 'runTurn').mockImplementation(async () => {
            const claim = currentTaskTurnClaim();
            expect(claim).toBeDefined();
            await reconcileSnapshotMutation({
                session: sessionManager,
                tenantId,
                sessionId: supersededTaskId,
                agentId,
                operation: 'test.replace.turn.claim',
                mutate: ({ snapshot }) => {
                    const meta = snapshot.meta as Record<string, unknown>;
                    const coordinator = meta.turnCoordinator as Record<string, unknown>;
                    const active = coordinator.active as Record<string, unknown>;
                    return {
                        kind: 'write' as const,
                        snapshot: {
                            ...snapshot,
                            meta: {
                                ...meta,
                                turnCoordinator: {
                                    ...coordinator,
                                    active: { ...active, claimId: 'replacement-claim' },
                                },
                            },
                        },
                        value: undefined,
                    };
                },
            });
            const cause = new TaskLifecycleTerminalError({
                tenantId,
                taskId: supersededTaskId,
                state: 'completed',
                effectKind: 'child',
            });
            throw new ModuleExecutionError(FrameworkModule.Execution, cause.message, cause);
        });

        const result = await executor.runSegment({
            tenantId,
            taskId: supersededTaskId,
            agentId,
            idempotencyKey: `${supersededTaskId}:start`,
            wake: { trigger: 'start', input: {} },
        });

        expect(result.turnDisposition).toBe('superseded');
        expect(executeTurnSpy).not.toHaveBeenCalled();
        turnSpy.mockRestore();
    });

    it('does not swallow a wrapped terminal-effect error while the claim remains valid', async () => {
        const activeTaskId = `${taskId}-wrapped-active`;
        const cause = new TaskLifecycleTerminalError({
            tenantId,
            taskId: activeTaskId,
            state: 'completed',
            effectKind: 'child',
        });
        const turnSpy = jest.spyOn(turnRunner, 'runTurn').mockRejectedValue(
            new ModuleExecutionError(FrameworkModule.Execution, cause.message, cause)
        );

        await expect(executor.runSegment({
            tenantId,
            taskId: activeTaskId,
            agentId,
            idempotencyKey: `${activeTaskId}:start`,
            wake: { trigger: 'start', input: {} },
        })).rejects.toMatchObject({
            code: 'MODULE_EXECUTION_ERROR',
            cause,
        });

        expect(executeTurnSpy).not.toHaveBeenCalled();
        turnSpy.mockRestore();
    });

    it('start → await_input → resume → complete through real TurnRunner', async () => {
        const inputToken = 'input-tok-1';
        let segment = 0;

        executeTurnSpy.mockImplementation(async (params) => {
            segment += 1;
            const M = params.M ?? initialM(params.ctx);
            if (segment === 1) {
                return persistMockTurn(params, {
                    M,
                    outcome: { kind: 'await_input', token: inputToken },
                    metrics: {},
                    taskStatus: {
                        state: 'input-required',
                        timestamp: new Date().toISOString(),
                        metadata: { token: inputToken },
                    },
                });
            }
            return persistMockTurn(params, {
                M,
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: {
                    state: 'completed',
                    timestamp: new Date().toISOString(),
                    metadata: { result: { done: true } },
                },
            });
        });

        const startResult = await executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: `${taskId}:start`,
            wake: { trigger: 'start', input: { question: 'hello' } },
        });

        expect(startResult.boundary).toEqual({ kind: 'await_input', token: inputToken });
        expect(startResult.taskStatus).toBe('input-required');
        expect(executeTurnSpy).toHaveBeenCalledTimes(1);

        const loaded = await sessionManager.load(tenantId, taskId);
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: taskId,
            agentId,
            expectedWmVersion: loaded?.wmVersion ?? BigInt(0),
            snapshot: setPendingInputs(
                (loaded?.snapshot as Record<string, unknown>) ?? {
                    meta: { agentId, turn: 1 },
                },
                { [inputToken]: {} }
            ),
        });

        const resumeResult = await executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: `${taskId}:input:${inputToken}`,
            wake: {
                trigger: 'resume',
                event: { kind: 'input', token: inputToken, value: 'my answer' },
            },
        });

        expect(resumeResult.boundary).toEqual({ kind: 'complete', result: { done: true } });
        expect(resumeResult.taskStatus).toBe('completed');
        expect(executeTurnSpy).toHaveBeenCalledTimes(2);

        const inbox = (await sessionManager.load(tenantId, taskId))?.snapshot as {
            inbox?: { current: Array<{ kind: string; payload: { value: string } }> };
        };
        expect(inbox?.inbox?.current[0]?.kind).toBe('input.provided');
        expect(inbox?.inbox?.current[0]?.payload.value).toBe('my answer');
    });

    it('restores streaming reply delivery on a reconstructed input resume', async () => {
        const streamingTaskId = `${taskId}-streaming-resume`;
        const inputToken = 'streaming-input-token';
        const events: A2AEvent[] = [];
        let segment = 0;
        await eventBus.subscribe(taskChannel(streamingTaskId), async (event) => {
            events.push(event.payload.data as A2AEvent);
        });

        executeTurnSpy.mockImplementation(async (params) => {
            segment += 1;
            const M = params.M ?? initialM(params.ctx);
            if (segment === 1) {
                return persistMockTurn(params, {
                    M,
                    outcome: { kind: 'await_input', token: inputToken },
                    metrics: {},
                    taskStatus: {
                        state: 'input-required',
                        timestamp: new Date().toISOString(),
                        metadata: { token: inputToken },
                    },
                });
            }
            await params.ctx.reply('reply after resume');
            return persistMockTurn(params, {
                M,
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: {
                    state: 'completed',
                    timestamp: new Date().toISOString(),
                    metadata: { result: { done: true } },
                },
            });
        });

        await executor.runSegment({
            tenantId,
            taskId: streamingTaskId,
            agentId,
            idempotencyKey: `${streamingTaskId}:start`,
            wake: { trigger: 'start', input: {} },
        });

        const loaded = await sessionManager.load(tenantId, streamingTaskId);
        const snapshot = setPendingInputs(
            (loaded?.snapshot as Record<string, unknown>) ?? {},
            { [inputToken]: {} }
        );
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: streamingTaskId,
            agentId,
            expectedWmVersion: loaded?.wmVersion ?? BigInt(0),
            snapshot: {
                ...snapshot,
                meta: {
                    ...((snapshot.meta as Record<string, unknown> | undefined) ?? {}),
                    replyDeliveryMode: 'stream',
                },
            },
        });

        await executor.runSegment({
            tenantId,
            taskId: streamingTaskId,
            agentId,
            idempotencyKey: `${streamingTaskId}:input:${inputToken}`,
            wake: {
                trigger: 'resume',
                event: { kind: 'input', token: inputToken, value: 'answer' },
            },
        });
        await Promise.resolve();

        expect(events.filter((event) => 'artifact' in event)).toEqual([
            expect.objectContaining({
                id: streamingTaskId,
                artifact: expect.objectContaining({
                    parts: [
                        expect.objectContaining({
                            type: 'text',
                            text: 'reply after resume',
                        }),
                    ],
                }),
            }),
        ]);
    });

    it.each([
        {
            name: 'tool',
            snapshot: (token: string) => setPendingTools(
                { meta: { agentId, replyDeliveryMode: 'stream' } },
                { [token]: { name: 'fetch', args: {} } }
            ),
            wake: (token: string) => ({
                trigger: 'tool' as const,
                event: { kind: 'tool' as const, token, result: { ok: true } },
            }),
        },
        {
            name: 'child',
            snapshot: (token: string) => setPendingTasks(
                { meta: { agentId, replyDeliveryMode: 'stream' } },
                { [token]: { target: 'child-agent', handlers: {} } }
            ),
            wake: (token: string) => ({
                trigger: 'child' as const,
                event: {
                    kind: 'child' as const,
                    token,
                    childTaskId: 'child-task',
                    outcome: 'completed' as const,
                    output: { result: { ok: true } },
                },
            }),
        },
        {
            name: 'external event',
            snapshot: (token: string) => setPendingExternalEvents(
                { meta: { agentId, replyDeliveryMode: 'stream' } },
                { [token]: { type: 'webhook.received' } }
            ),
            wake: (token: string) => ({
                trigger: 'event' as const,
                event: {
                    kind: 'external' as const,
                    token,
                    type: 'webhook.received',
                    data: { ok: true },
                },
            }),
        },
        {
            name: 'timer',
            snapshot: () => ({ meta: { agentId, replyDeliveryMode: 'stream' } }),
            wake: (token: string) => ({
                trigger: 'timer' as const,
                event: {
                    kind: 'timer' as const,
                    token,
                    timerId: 'timer-1',
                    dueAt: '2026-07-27T00:00:00.000Z',
                    firedAt: '2026-07-27T00:00:01.000Z',
                    reason: 'sleep_due' as const,
                },
            }),
        },
        {
            name: 'conversation',
            snapshot: () => ({ meta: { agentId, replyDeliveryMode: 'stream' } }),
            wake: (token: string) => ({
                trigger: 'conversation' as const,
                event: {
                    kind: 'conversation' as const,
                    token,
                    messageId: 'message-1',
                    data: { kind: 'message.received', text: 'hello' },
                },
            }),
        },
    ])('restores streaming reply delivery on a reconstructed $name wake', async (scenario) => {
        const wakeTaskId = `${taskId}-streaming-${scenario.name.replaceAll(' ', '-')}`;
        const token = `${scenario.name.replaceAll(' ', '-')}-token`;
        const events: A2AEvent[] = [];
        await eventBus.subscribe(taskChannel(wakeTaskId), async (event) => {
            events.push(event.payload.data as A2AEvent);
        });
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: wakeTaskId,
            agentId,
            expectedWmVersion: BigInt(0),
            snapshot: withCompletedCoordinator(scenario.snapshot(token)),
        });
        executeTurnSpy.mockImplementation(async (params) => {
            await params.ctx.reply(`reply after ${scenario.name}`);
            return persistMockTurn(params, {
                M: params.M ?? initialM(params.ctx),
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: {
                    state: 'completed',
                    timestamp: new Date().toISOString(),
                    metadata: { result: { done: true } },
                },
            });
        });

        await executor.runSegment({
            tenantId,
            taskId: wakeTaskId,
            agentId,
            idempotencyKey: `${wakeTaskId}:${token}`,
            wake: scenario.wake(token),
        });
        await Promise.resolve();

        expect(events.filter((event) => 'artifact' in event)).toEqual([
            expect.objectContaining({
                id: wakeTaskId,
                artifact: expect.objectContaining({
                    parts: [
                        expect.objectContaining({
                            type: 'text',
                            text: `reply after ${scenario.name}`,
                        }),
                    ],
                }),
            }),
        ]);
    });

    it('duplicate idempotencyKey is a no-op', async () => {
        executeTurnSpy.mockImplementation(async (params) => persistMockTurn(params, {
            M: initialM({
                task: { id: taskId, input: {} },
                logger: console,
                progress: jest.fn(),
                fail: jest.fn(),
            } as TaskContext),
            outcome: { kind: 'complete' },
            metrics: {},
            taskStatus: { state: 'completed', timestamp: new Date().toISOString() },
        }));

        const key = `${taskId}:start`;
        await executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: key,
            wake: { trigger: 'start', input: {} },
        });
        await executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: key,
            wake: { trigger: 'start', input: {} },
        });

        expect(executeTurnSpy).toHaveBeenCalledTimes(1);
    });

    it('executes a durably queued generation after the active turn releases', async () => {
        let releaseFirst!: () => void;
        let firstEntered!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
        let invocation = 0;
        executeTurnSpy.mockImplementation(async (params) => {
            invocation += 1;
            const M = params.M ?? initialM(params.ctx);
            if (invocation === 1) {
                firstEntered();
                await firstGate;
                return persistMockTurn(params, {
                    M,
                    outcome: { kind: 'await_input', token: 'queued-input' },
                    metrics: {},
                    taskStatus: {
                        state: 'input-required',
                        timestamp: new Date().toISOString(),
                        metadata: { token: 'queued-input' },
                    },
                });
            }
            return persistMockTurn(params, {
                M,
                outcome: { kind: 'complete', result: { generation: 2 } },
                metrics: {},
                taskStatus: {
                    state: 'completed',
                    timestamp: new Date().toISOString(),
                    metadata: { result: { generation: 2 } },
                },
            });
        });

        const first = executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: `${taskId}:start:first`,
            wake: { trigger: 'start', input: { generation: 1 } },
        });
        await entered;

        const queued = await executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: `${taskId}:start:second`,
            wake: { trigger: 'start', input: { generation: 2 } },
        });
        expect(queued.turnDisposition).toBe('queued');
        expect(queued.associatedTurnSeq).toBe(1);
        expect(executeTurnSpy).toHaveBeenCalledTimes(1);

        releaseFirst();
        await first;

        const executed = await executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: `${taskId}:start:second`,
            wake: { trigger: 'start', input: { generation: 2 } },
        });
        expect(executed.turnDisposition).toBe('executed');
        expect(executed.boundary).toEqual({ kind: 'complete', result: { generation: 2 } });
        expect(executeTurnSpy).toHaveBeenCalledTimes(2);
    });

    it('persists processed keys in the snapshot for durable duplicate detection', async () => {
        executeTurnSpy.mockImplementation(async (params) => persistMockTurn(params, {
            M: initialM({
                task: { id: taskId, input: {} },
                logger: console,
                progress: jest.fn(),
                fail: jest.fn(),
            } as TaskContext),
            outcome: { kind: 'complete' },
            metrics: {},
            taskStatus: { state: 'completed', timestamp: new Date().toISOString() },
        }));

        const key = `${taskId}:start`;
        await executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: key,
            wake: { trigger: 'start', input: {} },
        });

        const persisted = await sessionManager.load(tenantId, taskId);
        expect(readProcessedSegmentKeys(persisted?.snapshot ?? {})).toContain(key);

        const freshExecutor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task) =>
                ({
                    task,
                    logger: console,
                    progress: jest.fn(),
                    fail: jest.fn(),
                }) as TaskContext,
            dedupe: createInMemorySegmentDedupe(),
        });

        await freshExecutor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: key,
            wake: { trigger: 'start', input: {} },
        });

        expect(executeTurnSpy).toHaveBeenCalledTimes(1);
    });

    it('records the processed key atomically with snapshot writes inside a segment', async () => {
        const key = `${taskId}:start`;
        const token = 'tool-crash-token';
        executeTurnSpy.mockImplementation(async (params) => {
            const loaded = await params.sessionManager.load(params.tenantId, params.sessionId);
            await params.sessionManager.saveSnapshot({
                tenantId: params.tenantId,
                sessionId: params.sessionId,
                agentId: params.agentId,
                expectedWmVersion: loaded?.wmVersion ?? BigInt(0),
                snapshot: setPendingTools(
                    {
                        ...((loaded?.snapshot as Record<string, unknown>) ?? {}),
                        meta: {
                            ...(((loaded?.snapshot as { meta?: Record<string, unknown> } | undefined)?.meta) ?? {}),
                            agentId: params.agentId,
                            awaiting: { kind: 'await_tool', token },
                        },
                        inbox: { current: [], all: [] },
                    },
                    { [token]: { name: 'fetch', args: {} } }
                ),
            });
            throw new Error('worker died after snapshot write');
        });

        await expect(executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: key,
            wake: { trigger: 'start', input: {} },
        })).rejects.toThrow('worker died after snapshot write');

        const persisted = await sessionManager.load(tenantId, taskId);
        expect(readProcessedSegmentKeys(persisted?.snapshot ?? {})).toContain(key);

        const freshExecutor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task) =>
                ({
                    task,
                    logger: console,
                    progress: jest.fn(),
                    fail: jest.fn(),
                }) as TaskContext,
            dedupe: createInMemorySegmentDedupe(),
        });

        const duplicate = await freshExecutor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: key,
            wake: { trigger: 'start', input: {} },
        });

        expect(duplicate.boundary).toEqual({ kind: 'await_tool', token });
        expect(duplicate.taskStatus).toBe('working');
        expect(executeTurnSpy).toHaveBeenCalledTimes(1);
    });

    it('turns a late wake into a durable canceled boundary without applying the wake', async () => {
        const token = 'input-tok-canceled';
        const snapshot = markSegmentCancellationRequested(
            setPendingInputs(
                {
                    meta: { agentId, turn: 1 },
                    inbox: { current: [] },
                },
                { [token]: {} }
            ),
            'user requested stop',
            '2026-06-19T00:00:00.000Z'
        );
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: taskId,
            agentId,
            expectedWmVersion: BigInt(0),
            snapshot: withCompletedCoordinator(snapshot),
        });

        const result = await executor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: `${taskId}:input:${token}`,
            wake: {
                trigger: 'resume',
                event: { kind: 'input', token, value: 'too late' },
            },
        });

        expect(result.boundary).toEqual({ kind: 'canceled', reason: 'user requested stop' });
        expect(result.taskStatus).toBe('canceled');
        expect(executeTurnSpy).not.toHaveBeenCalled();

        const persisted = await sessionManager.load(tenantId, taskId);
        expect(readProcessedSegmentKeys(persisted?.snapshot ?? {})).toContain(`${taskId}:input:${token}`);
        expect((persisted?.snapshot as { inbox?: { current?: unknown[] } }).inbox?.current).toEqual([]);
    });

    it('returns canceled for duplicate wake delivery after a restart', async () => {
        const token = 'input-tok-duplicate-canceled';
        const idempotencyKey = `${taskId}:input:${token}`;
        const snapshot = markSegmentCancellationRequested(
            {
                meta: {
                    agentId,
                    awaiting: { kind: 'await_input', token },
                    processedKeys: [idempotencyKey],
                },
            },
            'stop',
            '2026-06-19T00:00:00.000Z'
        );
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: taskId,
            agentId,
            expectedWmVersion: BigInt(0),
            snapshot: withCompletedCoordinator(snapshot),
        });

        const freshExecutor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task) =>
                ({
                    task,
                    logger: console,
                    progress: jest.fn(),
                    fail: jest.fn(),
                }) as TaskContext,
            dedupe: createInMemorySegmentDedupe(),
        });

        const result = await freshExecutor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey,
            wake: {
                trigger: 'resume',
                event: { kind: 'input', token, value: 'duplicate' },
            },
        });

        expect(result.boundary).toEqual({ kind: 'canceled', reason: 'stop' });
        expect(result.taskStatus).toBe('canceled');
        expect(executeTurnSpy).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'input',
            idempotencyKey: `${taskId}:input:input-restart-token`,
            snapshot: setPendingInputs(
                {
                    meta: {
                        agentId,
                        awaiting: { kind: 'await_input', token: 'input-restart-token' },
                        processedKeys: [`${taskId}:input:input-restart-token`],
                    },
                    inbox: { current: [], all: [] },
                },
                { 'input-restart-token': {} }
            ),
            wake: {
                trigger: 'resume' as const,
                event: { kind: 'input' as const, token: 'input-restart-token', value: 'duplicate answer' },
            },
            expectedBoundary: { kind: 'await_input' as const, token: 'input-restart-token' },
        },
        {
            name: 'tool',
            idempotencyKey: `${taskId}:tool:tool-restart-token`,
            snapshot: setPendingTools(
                {
                    meta: {
                        agentId,
                        awaiting: { kind: 'await_tool', token: 'tool-restart-token' },
                        processedKeys: [`${taskId}:tool:tool-restart-token`],
                    },
                    inbox: { current: [], all: [] },
                },
                { 'tool-restart-token': { name: 'fetch', args: { url: 'https://example.com' } } }
            ),
            wake: {
                trigger: 'tool' as const,
                event: { kind: 'tool' as const, token: 'tool-restart-token', result: { ok: true } },
            },
            expectedBoundary: { kind: 'await_tool' as const, token: 'tool-restart-token' },
        },
        {
            name: 'child',
            idempotencyKey: `${taskId}:child:child-restart-token`,
            snapshot: setPendingTasks(
                {
                    meta: {
                        agentId,
                        awaiting: { kind: 'await_child', token: 'child-restart-token' },
                        processedKeys: [`${taskId}:child:child-restart-token`],
                    },
                    inbox: { current: [], all: [] },
                },
                { 'child-restart-token': { target: 'child-agent', handlers: {} } }
            ),
            wake: {
                trigger: 'child' as const,
                event: {
                    kind: 'child' as const,
                    token: 'child-restart-token',
                    childTaskId: 'child-task-1',
                    output: { ok: true },
                },
            },
            expectedBoundary: { kind: 'await_child' as const, token: 'child-restart-token' },
        },
        {
            name: 'external',
            idempotencyKey: `${taskId}:external:event-restart-token`,
            snapshot: setPendingExternalEvents(
                {
                    meta: {
                        agentId,
                        awaiting: { kind: 'await_event', token: 'event-restart-token' },
                        processedKeys: [`${taskId}:external:event-restart-token`],
                    },
                    inbox: { current: [], all: [] },
                },
                { 'event-restart-token': { type: 'webhook.received' } }
            ),
            wake: {
                trigger: 'event' as const,
                event: {
                    kind: 'external' as const,
                    token: 'event-restart-token',
                    type: 'webhook.received',
                    data: { ok: true },
                },
            },
            expectedBoundary: { kind: 'await_event' as const, token: 'event-restart-token' },
        },
    ])('dedupes duplicate $name wake after executor restart', async (scenario) => {
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: taskId,
            agentId,
            expectedWmVersion: BigInt(0),
            snapshot: withCompletedCoordinator(scenario.snapshot),
        });

        const freshExecutor = new TurnRunnerSegmentExecutor({
            turnRunner,
            sessionManager,
            createContext: (task) =>
                ({
                    task,
                    logger: console,
                    progress: jest.fn(),
                    fail: jest.fn(),
                }) as TaskContext,
            dedupe: createInMemorySegmentDedupe(),
        });

        const result = await freshExecutor.runSegment({
            tenantId,
            taskId,
            agentId,
            idempotencyKey: scenario.idempotencyKey,
            wake: scenario.wake,
        });

        expect(result.boundary).toEqual(scenario.expectedBoundary);
        expect(result.taskStatus).toBe(
            scenario.expectedBoundary.kind === 'await_input' ? 'input-required' : 'working'
        );
        expect(executeTurnSpy).not.toHaveBeenCalled();

        const persisted = await sessionManager.load(tenantId, taskId);
        expect(readProcessedSegmentKeys(persisted?.snapshot ?? {})).toContain(scenario.idempotencyKey);
        expect((persisted?.snapshot as { inbox?: { current?: unknown[] } }).inbox?.current).toEqual([]);
    });
});
