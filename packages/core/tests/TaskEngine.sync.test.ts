import { jest } from '@jest/globals';
import path from 'node:path';
import type { TaskContext } from '../src/shared/types/index.js';

describe('TaskEngine sync completion', () => {
    const tenantId = 'tenant-test';
    const parentTaskId = 'parent-task';
    const srcDir = path.resolve(process.cwd(), 'packages/core/src');

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

    const buildEngine = async (sendTaskToAgent?: (params: any) => Promise<any>) => {
        jest.resetModules();
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        const sendMock = jest.fn(sendTaskToAgent ?? (async () => undefined));
        const findMock = jest.fn(async () => ({
            manifest: { name: 'child-agent' },
            resolved: {
                agentCard: { name: 'child-agent', version: '1.0.0' },
                runtimeManifest: { name: 'child-agent', version: '1.0.0' },
            },
            loop: {},
            llmAdapter: {},
            tenantId,
        }));
        await jest.unstable_mockModule(path.join(srcDir, 'orchestration/A2AService.ts'), () => ({
            globalA2AService: {
                sendTaskToAgent: sendMock,
                findLocalAgent: findMock,
            },
        }));
        const [{ TaskEngine }, { InMemorySessionManager }] = await Promise.all([
            import(path.join(srcDir, 'orchestration/taskEngine.ts')),
            import(path.join(srcDir, 'orchestration/InMemorySessionManager.ts')),
        ]);
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        // Access private sessionManager for test setup
        const sessionManager = (engine as any).sessionManager;
        return { engine, sessionManager, sendMock };
    };

    const setupContext = async (engine: any, sessionManager: any) => {
        const taskEntity = { id: parentTaskId, input: {} };
        // Create context using private method
        const ctx: TaskContext = (engine as any).createContext(taskEntity);

        // Ensure session data exists with complete mental state structure
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: 'parent-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    agentId: 'parent-agent', turn: 0,
                    turnCoordinator: {
                        schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                        requestedGeneration: '0', completedGeneration: '0',
                    },
                },
                M: {
                    memory: {
                        vars: {},
                        sensory: {},
                        longTerm: { semantic: {}, episodic: [], procedural: {} }
                    },
                    worldModel: { explicit: null, implicit: null, simulator: null },
                    goalState: { hierarchy: { roots: [], nodes: {} } },
                    emotion: { valence: 0, arousal: 0.2 },
                    policyParams: { theta: null, stochastic: false },
                    rewardParams: {
                        discountGamma: 0.99,
                        extrinsicWeights: [1],
                        intrinsic: { exploration: 0, curiosity: 0, competence: 0, novelty: 0 }
                    }
                }
            }
        });

        // Attach orchestration APIs using private method (via apiBinder)
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId: parentTaskId,
            agentId: 'parent-agent',
            flushMentalState: async () => { } // no-op
        });

        return ctx;
    };

    it('returns object with token when sync child returns a result object (fix for cache hit bug)', async () => {
        const mockResult = {
            status: { state: 'completed' },
            data: { some: 'data' }
        };
        const { engine, sessionManager } = await buildEngine(async () => mockResult);
        const ctx = await setupContext(engine, sessionManager);


        // Call context API
        const result = await ctx.sendTaskToAgent('child-agent', { some: 'input' }) as any;

        expect(result).toBeDefined();
        // The fix ensures token is present even if spread failed or A2A returned undefined
        expect(result.token).toBeDefined();
        // New API returns { handle, token } where result fields are in handle
        expect(result.handle).toBeDefined();
        expect(result.handle.status).toEqual(mockResult.status);
        expect(result.handle.data).toEqual(mockResult.data);
    });

    it('returns object with token when sync child returns undefined (fallback path)', async () => {
        const { engine, sessionManager } = await buildEngine(async () => undefined);
        const ctx = await setupContext(engine, sessionManager);

        const result = await ctx.sendTaskToAgent('child-agent', { some: 'input' }) as any;

        expect(result).toBeDefined();
        expect(result.token).toBeDefined();
        // Handle should not be empty, but should not have status/data from result
        expect(result.handle).toBeDefined();
        // Since result was undefined, these properties wouldn't be assigned
        expect((result.handle as any).status).toBeUndefined();
        expect((result.handle as any).data).toBeUndefined();
    });

    it('injects flattened child result into active loop inbox (Payload Consistency Fix)', async () => {
        // Mock a TaskEntity result (wrapped)
        const mockChildTaskEntity = {
            id: 'child-task-123',
            status: {
                state: 'completed',
                timestamp: 123456,
                metadata: {
                    result: { data: 'actual-result' }, // standard result wrapper
                    timings: { start: 1, end: 2 }
                }
            }
        };
        const { engine, sessionManager } = await buildEngine(async () => mockChildTaskEntity);
        const ctx = await setupContext(engine, sessionManager);
        const mockInbox: any = { current: [], all: [] };
        (ctx as any).__activeLoopInbox = mockInbox;
        (ctx as any).__activeLoopEnv = { turn: 5 };

        const result = await ctx.sendTaskToAgent('child-agent', { some: 'input' }, { awaitCompletion: true }) as any;

        expect(result.token).toBeDefined();

        // Verify inbox injection
        expect(mockInbox.current.length).toBe(1);
        const obs = mockInbox.current[0];

        // CHECK PAYLOAD CONSISTENCY FIX
        // Should have unnested result, id, and executionMetadata at top level of payload
        expect(obs.source).toBe('child');
        expect(obs.kind).toBe('child.completed');
        expect(obs.payload).toBeDefined();

        // 1. Flattened ID
        expect(obs.payload.childTaskId).toBe('child-task-123');

        // 2. Extracted Result (should NOT be undefined, should be { data: 'actual-result' })
        expect(obs.payload.result).toEqual({ data: 'actual-result' });

        // 3. Execution Metadata (should be populated)
        expect(obs.payload.executionMetadata).toBeDefined();
        expect(obs.payload.executionMetadata?.timings).toEqual({ start: 1, end: 2 });
    });

    it('injects artifact-backed child HTML into active loop inbox', async () => {
        const rawHtml = `<html>${'active-loop-child-html'.repeat(5000)}</html>`;
        const mockChildTaskEntity = {
            id: 'child-task-large',
            status: {
                state: 'completed',
                timestamp: 123456,
                metadata: {
                    result: {
                        ok: true,
                        data: {
                            html: rawHtml,
                            content: rawHtml,
                        },
                    },
                },
            },
        };
        const { engine, sessionManager } = await buildEngine(async () => mockChildTaskEntity);
        (sessionManager as any).store.prisma = createFakeArtifactPrisma();
        const ctx = await setupContext(engine, sessionManager);
        const mockInbox: any = { current: [], all: [] };
        (ctx as any).__activeLoopInbox = mockInbox;
        (ctx as any).__activeLoopEnv = { turn: 5 };

        await ctx.sendTaskToAgent('child-agent', { some: 'input' }, { awaitCompletion: true });

        const serialized = JSON.stringify(mockInbox);
        expect(serialized).not.toContain(rawHtml);
        const html = mockInbox.current[0]?.payload?.result?.data?.html;
        const content = mockInbox.current[0]?.payload?.result?.data?.content;
        expect(html).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
        expect(content).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
    });

    it('returns the canonical blocking-child artifact marker with the durable ID', async () => {
        const { Artifact } = await import('@a2arium/callagent-memory-engine');
        const rawHtml = `<html>${'canonical-child-html'.repeat(5000)}</html>`;
        const localArtifact = Artifact.create(rawHtml, { mimeType: 'text/html' });
        const mockChildTaskEntity = {
            id: 'child-task-canonical',
            status: {
                state: 'completed',
                timestamp: 123456,
                metadata: { result: { html: localArtifact } },
            },
        };
        const { engine, sessionManager } = await buildEngine(async () => mockChildTaskEntity);
        const prisma = createFakeArtifactPrisma();
        (sessionManager as any).store.prisma = prisma;
        const ctx = await setupContext(engine, sessionManager);
        const mockInbox: any = { current: [], all: [] };
        (ctx as any).__activeLoopInbox = mockInbox;
        (ctx as any).__activeLoopEnv = { turn: 5 };

        const returned = await ctx.sendTaskToAgent(
            'child-agent',
            { some: 'input' },
            { awaitCompletion: true }
        ) as any;

        const returnedArtifact = returned.handle.status.metadata.result.html;
        const observedArtifact = mockInbox.current[0].payload.result.html;
        expect(returnedArtifact.id).toBe(observedArtifact.id);
        expect(typeof returnedArtifact.then).toBe('function');
        await expect(returnedArtifact).resolves.toBe(rawHtml);
        expect(prisma.agentResultCache.upsert).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(returned)).not.toContain(rawHtml);
    });
});
