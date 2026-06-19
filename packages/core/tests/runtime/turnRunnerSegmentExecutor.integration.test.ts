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
import { readProcessedSegmentKeys } from '../../src/runtime/segmentProcessedKeys.js';

describe('TurnRunnerSegmentExecutor integration', () => {
    const tenantId = 'tenant-seg';
    const taskId = 'task-seg-1';
    const agentId = 'agent-seg';

    let store: InMemorySessionManager;
    let sessionManager: SessionManager;
    let turnRunner: TurnRunner;
    let executor: TurnRunnerSegmentExecutor;
    let executeTurnSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        store = new InMemorySessionManager();
        sessionManager = new SessionManager(store);
        const apiBinder = {
            attachOrchestrationAPIs: jest.fn().mockResolvedValue(undefined),
        } as unknown as ApiBinder;
        turnRunner = new TurnRunner(sessionManager, apiBinder, () => undefined, createInMemoryEventBus());

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

    it('start → await_input → resume → complete through real TurnRunner', async () => {
        const inputToken = 'input-tok-1';
        let segment = 0;

        executeTurnSpy.mockImplementation(async (params) => {
            segment += 1;
            const M = params.M ?? initialM(params.ctx);
            if (segment === 1) {
                return {
                    M,
                    outcome: { kind: 'await_input', token: inputToken },
                    metrics: {},
                    taskStatus: {
                        state: 'input-required',
                        timestamp: new Date().toISOString(),
                        metadata: { token: inputToken },
                    },
                };
            }
            return {
                M,
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: {
                    state: 'completed',
                    timestamp: new Date().toISOString(),
                    metadata: { result: { done: true } },
                },
            };
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

    it('duplicate idempotencyKey is a no-op', async () => {
        executeTurnSpy.mockResolvedValue({
            M: initialM({
                task: { id: taskId, input: {} },
                logger: console,
                progress: jest.fn(),
                fail: jest.fn(),
            } as TaskContext),
            outcome: { kind: 'complete' },
            metrics: {},
            taskStatus: { state: 'completed', timestamp: new Date().toISOString() },
        });

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

    it('persists processed keys in the snapshot for durable duplicate detection', async () => {
        executeTurnSpy.mockResolvedValue({
            M: initialM({
                task: { id: taskId, input: {} },
                logger: console,
                progress: jest.fn(),
                fail: jest.fn(),
            } as TaskContext),
            outcome: { kind: 'complete' },
            metrics: {},
            taskStatus: { state: 'completed', timestamp: new Date().toISOString() },
        });

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
});
