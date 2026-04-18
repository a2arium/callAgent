import { TurnRunner } from '../src/orchestration/TurnRunner.js';
import { createInMemoryEventBus } from '../src/eventbus/inMemoryEventBus.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { ApiBinder } from '../src/orchestration/api/ApiBinder.js';
import { TaskContext } from '../src/shared/types/index.js';
import { initialM } from '../src/loop/init.js';
import { jest } from '@jest/globals';
import { TaskExecutor } from '../src/orchestration/TaskExecutor.js';

describe('TurnRunner', () => {
    const tenantId = 'test-tenant';
    const sessionId = 'test-session';

    let store: InMemorySessionManager;
    let sessionManager: SessionManager;
    let apiBinder: ApiBinder;
    let turnRunner: TurnRunner;
    let ctx: TaskContext;

    beforeEach(() => {
        store = new InMemorySessionManager();
        sessionManager = new SessionManager(store);
        // Mock ApiBinder to avoid complex dependency chain
        apiBinder = {
            attachOrchestrationAPIs: jest.fn().mockResolvedValue(undefined)
        } as unknown as ApiBinder;

        turnRunner = new TurnRunner(
            sessionManager,
            apiBinder,
            () => undefined, // no prisma
            createInMemoryEventBus()
        );
        ctx = {
            task: { id: sessionId, input: {} },
            logger: console,
            progress: jest.fn(),
            fail: jest.fn()
        } as any;
    });

    it('should run a start turn successfully', async () => {
        // Mock TaskExecutor to avoid running actual loop logic
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn')
            .mockResolvedValue({
                M: initialM(ctx),
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: { state: 'completed', timestamp: 'test' }
            });

        const result = await turnRunner.runTurn(ctx, {
            tenantId,
            sessionId,
            trigger: 'start',
            isStreaming: false
        });

        expect(result).toBeDefined();
        expect(result.id).toEqual(sessionId);
        expect(result.status?.state).toEqual('completed');
        expect(executeTurnSpy).toHaveBeenCalled();

        executeTurnSpy.mockRestore();
    });

    it('should respect initialM override', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn')
            .mockResolvedValue({
                M: initialM(ctx),
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: { state: 'completed', timestamp: 'test' }
            });

        const customM = initialM(ctx);
        (customM as any).testProp = 'custom';

        await turnRunner.runTurn(ctx, {
            tenantId,
            sessionId,
            trigger: 'start',
            isStreaming: false
        }, {
            initialM: customM
        });

        const callArgs = executeTurnSpy.mock.calls[0][0];
        expect(callArgs.M).toBe(customM);

        executeTurnSpy.mockRestore();
    });

    it('should FAIL if session not found for resume without override', async () => {
        await expect(turnRunner.runTurn(ctx, {
            tenantId,
            sessionId,
            trigger: 'resume',
            isStreaming: false
        })).rejects.toThrow(/not found/);
    });

    it('should succeed for resume input via overrides', async () => {
        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn')
            .mockResolvedValue({
                M: initialM(ctx),
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: { state: 'completed', timestamp: 'test' }
            });

        const mockSnapshot = {
            M: initialM(ctx),
            meta: { turn: 1 }
        };

        const result = await turnRunner.runTurn(ctx, {
            tenantId,
            sessionId,
            trigger: 'resume',
            isStreaming: false,
            input: { token: 'abc' }
        }, {
            snapshot: mockSnapshot
        });

        expect(result.status?.state).toEqual('completed');
        executeTurnSpy.mockRestore();
    });
});
