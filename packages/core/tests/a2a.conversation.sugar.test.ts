import { jest } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import type { InternalTaskContext } from '../src/loop/internalContext.js';
import type { TaskContext } from '../src/shared/types/index.js';

process.env.DISABLE_OUTBOX_PUBLISHER = 'true';

describe('sendTaskToAgent conversation sugar', () => {
    const tenantId = 't-a2a-sugar';
    const parentTaskId = 'parent-a2a-1';
    const parentAgentId = 'parent-agent';
    let currentEngine: TaskEngine | undefined;

    afterEach(async () => {
        await currentEngine?.waitForBackgroundTasks?.({ timeoutMs: 5000 });
        currentEngine = undefined;
        EngineLocator.setEngine(undefined as never);
        jest.restoreAllMocks();
    });

    it('creates thread conversation_messages via startThread path', async () => {
        const childName = `sugar-child-${Date.now()}`;
        const engine = new TaskEngine({});
        currentEngine = engine;
        EngineLocator.setEngine(engine);
        const sessionManager = (engine as unknown as { sessionManager: import('../src/orchestration/SessionManager.js').SessionManager }).sessionManager;

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

        const mem = sessionManager['store'] as InMemorySessionManager;
        const msgMap = (mem as unknown as { conversationMessages: Map<string, unknown[]> }).conversationMessages;
        const keys = [...msgMap.keys()];
        expect(keys.length).toBeGreaterThan(0);
        const firstKey = keys[0]!;
        const sep = firstKey.indexOf(':');
        const conversationId = firstKey.slice(sep + 1);
        const rows = await sessionManager.listConversationMessages({ tenantId, conversationId });
        expect(rows.some((r) => r.conversationKind === 'thread')).toBe(true);
    });
});
