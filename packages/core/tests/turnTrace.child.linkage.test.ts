import { jest } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import type { InternalTaskContext } from '../src/loop/internalContext.js';
import type { TaskContext } from '../src/shared/types/index.js';

process.env.DISABLE_OUTBOX_PUBLISHER = 'true';

describe('TurnTrace child linkage (sendTaskToAgent)', () => {
    const tenantId = 't-link';
    const parentTaskId = 'parent-link-1';
    const parentAgentId = 'parent-agent';
    let currentEngine: TaskEngine | undefined;

    afterEach(async () => {
        await currentEngine?.waitForBackgroundTasks?.({ timeoutMs: 5000 });
        currentEngine = undefined;
        EngineLocator.setEngine(undefined as never);
        jest.restoreAllMocks();
    });

    it('stamps childAgentNodeId and childTraceId on successful handleTask child', async () => {
        const childName = `link-child-${Date.now()}`;
        const engine = new TaskEngine({});
        currentEngine = engine;
        EngineLocator.setEngine(engine);

        PluginManager.registerAgent({
            resolved: {
                agentCard: {
                    name: childName,
                    version: '1.0.0',
                    description: 't',
                    supportedInterfaces: [
                        { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'http://localhost' },
                    ],
                    capabilities: {},
                    defaultInputModes: ['text/plain'],
                    defaultOutputModes: ['text/plain'],
                    skills: [{ id: 's1', name: 's1', description: 's1' }],
                },
                runtimeManifest: { name: childName, version: '1.0.0', runMode: 'loop' },
                agentCardHash: 'h1',
                runtimeManifestHash: 'h2',
                agentCardSource: 'inline',
                runtimeManifestSource: 'inline',
            },
            tenantId,
            handleTask: async () => ({ status: 'completed', data: { ok: true } }),
        } as never);

        const sessionManager = (engine as unknown as { sessionManager: import('../src/orchestration/SessionManager.js').SessionManager }).sessionManager;
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: parentAgentId,
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: { agentId: parentAgentId, turn: 0 },
                M: {
                    memory: {
                        vars: {},
                        sensory: {},
                        longTerm: { semantic: {}, episodic: [], procedural: {} },
                    },
                    worldModel: { explicit: null, implicit: null, simulator: null },
                    goalState: { hierarchy: { roots: [], nodes: {} } },
                    emotion: { valence: 0, arousal: 0.2 },
                    policyParams: { theta: null, stochastic: false },
                    rewardParams: {
                        discountGamma: 0.99,
                        extrinsicWeights: [1],
                        intrinsic: { exploration: 0, curiosity: 0, competence: 0, novelty: 0 },
                    },
                },
            },
        });

        const ctx: TaskContext = (engine as unknown as { createContext: (t: { id: string; input: unknown }) => TaskContext }).createContext({
            id: parentTaskId,
            input: {},
        });
        ctx.tenantId = tenantId;
        ctx.agentId = parentAgentId;
        ctx.telemetry = { nodeId: 'parent-node', traceId: 'parent-trace' };

        await (engine as unknown as { apiBinder: { attachOrchestrationAPIs: (c: TaskContext, b: unknown) => Promise<void> } }).apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId: parentTaskId,
            agentId: parentAgentId,
            flushMentalState: async () => {},
        });

        const iCtx = ctx as InternalTaskContext;
        iCtx.__turnChildCalls = [];

        await ctx.sendTaskToAgent!(childName, { q: 1 }, { awaitCompletion: true, timeout: 30_000 });

        const completed = (iCtx.__turnChildCalls ?? []).filter((c) => c.status === 'completed');
        expect(completed.length).toBeGreaterThanOrEqual(1);
        const last = completed[completed.length - 1]!;
        expect(typeof last.childAgentNodeId).toBe('string');
        expect(typeof last.childTraceId).toBe('string');
    });
});
