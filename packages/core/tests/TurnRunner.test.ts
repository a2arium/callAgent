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

    const createFakeArtifactPrisma = () => {
        const artifacts = new Map<string, unknown>();
        return {
            agentResultCache: {
                upsert: jest.fn(async (args: any) => {
                    artifacts.set(args.create.cacheKey, args.create.result);
                    return args.create;
                }),
                findUnique: jest.fn(async (args: any) => {
                    const cacheKey = args.where?.tenantId_agentName_cacheKey?.cacheKey;
                    if (!artifacts.has(cacheKey)) return null;
                    return {
                        id: cacheKey,
                        result: artifacts.get(cacheKey),
                        createdAt: new Date(),
                        expiresAt: new Date(Date.now() + 60_000),
                    };
                }),
                delete: jest.fn(async () => ({})),
            },
        };
    };

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

    it('restores child completion events without hydrating large artifacts into raw snapshot data', async () => {
        const rawHtml = `<html>${'turn-runner-child-html'.repeat(5000)}</html>`;
        const artifactPrisma = createFakeArtifactPrisma();
        turnRunner = new TurnRunner(
            sessionManager,
            apiBinder,
            () => artifactPrisma,
            createInMemoryEventBus()
        );
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId,
            agentId: 'agent-a',
            expectedWmVersion: BigInt(0),
            snapshot: {
                M: initialM(ctx),
                meta: { turn: 1, agentId: 'agent-a', lastChildToken: 'child-token' },
                inbox: { current: [], all: [] },
            },
        });
        await sessionManager.appendEvent(tenantId, sessionId, 'task.child_completed', {
            token: 'child-token',
            childTaskId: 'child-task-1',
            agentId: 'child-agent',
            result: {
                ok: true,
                data: {
                    html: rawHtml,
                    content: rawHtml,
                },
            },
        });

        const executeTurnSpy = jest.spyOn(TaskExecutor, 'executeTurn')
            .mockImplementation(async (params: any) => ({
                M: params.M,
                outcome: { kind: 'complete', result: { done: true } },
                metrics: {},
                taskStatus: { state: 'completed', timestamp: 'test' },
            }));

        await turnRunner.runTurn(ctx, {
            tenantId,
            sessionId,
            trigger: 'resume',
            isStreaming: false,
        });

        const env = executeTurnSpy.mock.calls[0][0].env;
        const serializedInbox = JSON.stringify(env.inbox);
        expect(serializedInbox).not.toContain(rawHtml);
        const obs = env.inbox.all.find((entry: any) => entry?.payload?.token === 'child-token');
        expect(obs).toBeDefined();
        expect(obs?.payload?.result?.data?.html).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
        expect(obs?.payload?.result?.data?.content).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));

        executeTurnSpy.mockRestore();
    });
});
