import { describe, it, expect, afterEach } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { LoopRegistry } from '../src/orchestration/LoopRegistry.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import type { AgentPlugin } from '../src/plugin/types.js';
import type { InternalTaskContext } from '../src/loop/internalContext.js';
import type { MentalState, EnvironmentState, MemoryReader, MemoryWriter } from '../src/loop/types.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { Intent, ExecutableAction } from '../src/types/intent.js';
import type { ExecOutcome } from '../src/types/execOutcome.js';
import type { Observation } from '../src/types/observation.js';

process.env.DISABLE_OUTBOX_PUBLISHER = 'true';

type TestSensory = {
    phase?: 'started' | 'tool_done';
};

type ParentSensory = {
    status?: 'idle' | 'fetching' | 'completed';
    childToken?: string;
    content?: string;
};

type TestObservation =
    | { kind: 'input' }
    | { kind: 'tool_completed'; result: unknown }
    | { kind: 'none' };

type ParentObservation =
    | { kind: 'input' }
    | { kind: 'child_content'; content: string }
    | { kind: 'none' };

type ToolHandle = {
    token: string;
};

type EngineAccess = {
    createContext: (task: { id: string; input: unknown }) => TaskContext;
    startTask: (params: {
        task: { id: string; input: unknown };
        isStreaming: boolean;
        agentId: string;
        tenantId: string;
    }) => Promise<unknown>;
    apiBinder: {
        attachOrchestrationAPIs: (
            ctx: TaskContext,
            params: {
                tenantId: string;
                sessionId: string;
                agentId: string;
                flushMentalState: () => Promise<void>;
            }
        ) => Promise<void>;
    };
    sessionManager: {
        load: (
            tenantId: string,
            sessionId: string
        ) => Promise<{ snapshot?: Record<string, unknown>; wmVersion?: bigint } | undefined>;
        saveSnapshot: (params: {
            tenantId: string;
            sessionId: string;
            agentId: string;
            expectedWmVersion: bigint;
            snapshot: Record<string, unknown>;
        }) => Promise<unknown>;
        snapshots?: Map<string, { agentId?: string; snapshot?: Record<string, unknown> }>;
    };
};

type SendTaskDispatch = {
    token: string;
    handle?: { id?: unknown };
};

type SnapshotWithPending = Record<string, unknown> & {
    pending?: {
        tools?: Record<string, unknown>;
    };
};

type TestSnapshotStore = {
    snapshots?: Map<string, { agentId?: string; snapshot?: Record<string, unknown> }>;
};

type TestSessionManagerInternals = {
    store?: TestSnapshotStore;
};

const isToolHandle = (value: unknown): value is ToolHandle =>
    typeof value === 'object' &&
    value !== null &&
    'token' in value &&
    typeof (value as { token?: unknown }).token === 'string';

const isSendTaskDispatch = (value: unknown): value is SendTaskDispatch =>
    typeof value === 'object' &&
    value !== null &&
    'token' in value &&
    typeof (value as { token?: unknown }).token === 'string';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;

const firstString = (...values: unknown[]): string | undefined =>
    values.find((value): value is string => typeof value === 'string' && value.length > 0);

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        }),
    ]);

const createAgentCard = (name: string) => ({
    name,
    version: '1.0.0',
    description: 'A2A async child repro agent',
    supportedInterfaces: [
        { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'http://localhost' },
    ],
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'repro', name: 'repro', description: 'repro' }],
});

const createResolved = (name: string) => ({
    agentCard: createAgentCard(name),
    runtimeManifest: {
        name,
        version: '1.0.0',
        runMode: 'loop',
        budgets: { maxTurns: 3 },
    },
    agentCardHash: `${name}-card`,
    runtimeManifestHash: `${name}-runtime`,
    agentCardSource: 'inline',
    runtimeManifestSource: 'inline',
});

const createParentSnapshot = (agentId: string): Record<string, unknown> => ({
    meta: { agentId, turn: 0 },
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
});

const createSuspendingChildPlugin = (name: string, tenantId: string): AgentPlugin => ({
    resolved: createResolved(name),
    tenantId,
    loop: {
        modules: {
            attention: () => ({}),
            perception: (env: EnvironmentState): TestObservation => {
                const toolObservation = env.inbox.current.find(
                    (entry: Observation) => entry.source === 'tool' && entry.kind === 'tool.completed'
                );
                return toolObservation
                    ? { kind: 'tool_completed', result: toolObservation.payload }
                    : { kind: 'none' };
            },
            learning: (
                prev: MentalState<TestSensory>,
                _prevAction: Intent | undefined,
                observation: TestObservation
            ): MentalState<TestSensory> => {
                if (observation.kind !== 'tool_completed') {
                    return prev;
                }
                return {
                    ...prev,
                    memory: {
                        ...prev.memory,
                        sensory: { phase: 'tool_done' },
                    },
                };
            },
            policy: (m: MentalState<TestSensory>, _mem: MemoryReader): Intent => ({
                kind: 'internal',
                intent: m.memory.sensory.phase === 'tool_done' ? 'finish' : 'start_tool',
            }),
            shield: (_m: MentalState<TestSensory>, intent: Intent) => ({ action: 'pass', intent }),
            execution: async (intent: Intent, ctx: TaskContext): Promise<ExecOutcome> => {
                if (intent.kind === 'internal' && intent.intent === 'finish') {
                    return {
                        action: { kind: 'internal', done: true },
                        result: { status: 'ok', data: { status: 'done', html: '<html>ok</html>' } },
                    };
                }

                if (intent.kind !== 'internal' || intent.intent !== 'start_tool') {
                    return {
                        action: { kind: 'internal', done: false },
                        result: { status: 'ok', data: { status: 'waiting' } },
                    };
                }

                // Keep this repro focused on the first child segment: the child should
                // suspend on await_tool, not complete via a background tool resume.
                const toolCtx = ctx as TaskContext & { __autoExecuteTool?: unknown };
                toolCtx.__autoExecuteTool = undefined;
                const handle = await ctx.requestTool?.('slow-tool', { q: 1 }, { awaitCompletion: false });
                if (!isToolHandle(handle)) {
                    throw new Error('Expected requestTool to return a tool token');
                }

                const action: ExecutableAction = { kind: 'call_tool', token: handle.token };
                return {
                    action,
                    result: {
                        status: 'ok',
                        data: { status: 'tool_requested' },
                    },
                };
            },
            transition: (_env: EnvironmentState, exec: ExecOutcome) => {
                if (exec.action.kind === 'call_tool' && exec.action.token) {
                    return { kind: 'await_tool' as const, token: exec.action.token };
                }
                if (exec.action.kind === 'internal' && exec.action.done) {
                    return { kind: 'complete' as const, result: exec.result.data };
                }
                return { kind: 'continue' as const, observations: [] };
            },
        },
    },
} as unknown as AgentPlugin);

const createAwaitingParentPlugin = (name: string, childAgentId: string, tenantId: string): AgentPlugin => ({
    resolved: createResolved(name),
    tenantId,
    loop: {
        modules: {
            attention: () => ({}),
            perception: (env: EnvironmentState): ParentObservation => {
                for (const entry of env.inbox.current) {
                    if (entry.source === 'user') {
                        return { kind: 'input' };
                    }
                    if (entry.source === 'child' && entry.kind === 'child.completed') {
                        const payload = asRecord(entry.payload);
                        const result = asRecord(payload?.result);
                        const data = asRecord(result?.data);
                        const content = firstString(data?.html, data?.content, result?.html, result?.content);
                        if (content) {
                            return { kind: 'child_content', content };
                        }
                    }
                }
                return { kind: 'none' };
            },
            learning: (
                prev: MentalState<ParentSensory>,
                _prevAction: Intent | undefined,
                observation: ParentObservation
            ): MentalState<ParentSensory> => {
                if (observation.kind !== 'child_content') {
                    return prev;
                }
                return {
                    ...prev,
                    memory: {
                        ...prev.memory,
                        sensory: {
                            ...prev.memory.sensory,
                            status: 'completed',
                            content: observation.content,
                            childToken: undefined,
                        },
                    },
                };
            },
            policy: (m: MentalState<ParentSensory>, _mem: MemoryReader): Intent => {
                const sensory = m.memory.sensory;
                if (sensory.status === 'completed') {
                    return { kind: 'internal', intent: 'complete' };
                }
                if (sensory.status === 'fetching' && sensory.childToken) {
                    return { kind: 'internal', intent: 'wait' };
                }
                return { kind: 'internal', intent: 'start_child' };
            },
            shield: (_m: MentalState<ParentSensory>, intent: Intent) => ({ action: 'pass', intent }),
            execution: async (intent: Intent, ctx: TaskContext): Promise<ExecOutcome> => {
                if (intent.kind === 'internal' && intent.intent === 'complete') {
                    return {
                        action: { kind: 'internal', done: true },
                        result: { status: 'ok', data: { status: 'final_complete' } },
                    };
                }
                if (intent.kind === 'internal' && intent.intent === 'wait') {
                    return {
                        action: { kind: 'internal', done: false },
                        result: { status: 'ok', data: { status: 'waiting' } },
                    };
                }
                const dispatch = await ctx.sendTaskToAgent?.(
                    childAgentId,
                    { q: 1 },
                    { awaitCompletion: false, timeout: 30_000 }
                );
                if (!isSendTaskDispatch(dispatch)) {
                    throw new Error('Expected sendTaskToAgent to return a child token');
                }
                return {
                    action: { kind: 'internal', token: dispatch.token },
                    result: { status: 'ok', data: { status: 'child_delegated', token: dispatch.token } },
                };
            },
            transition: (_env: EnvironmentState, exec: ExecOutcome) => {
                const data = asRecord(exec.result.data);
                const token = firstString(data?.token);
                if (data?.status === 'child_delegated' && token) {
                    return { kind: 'await_child' as const, token };
                }
                if (data?.status === 'final_complete') {
                    return { kind: 'complete' as const, result: { ok: true } };
                }
                return { kind: 'continue' as const, observations: [] };
            },
        },
    },
} as unknown as AgentPlugin);

describe('A2A async child lifecycle', () => {
    afterEach(() => {
        EngineLocator.setEngine(undefined as never);
    });

    it('does not inject child.completed when the child only suspended on an async tool', async () => {
        const tenantId = 't-a2a-async-child-repro';
        const parentAgentId = `parent-repro-${Date.now()}`;
        const childAgentId = `child-repro-${Date.now()}`;
        const parentTaskId = `parent-task-${Date.now()}`;
        const engine = new TaskEngine({});
        EngineLocator.setEngine(engine);

        PluginManager.registerAgent(createSuspendingChildPlugin(childAgentId, tenantId));

        const engineAccess = engine as unknown as EngineAccess;
        await engineAccess.sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: parentAgentId,
            expectedWmVersion: BigInt(0),
            snapshot: createParentSnapshot(parentAgentId),
        });

        const ctx = engineAccess.createContext({ id: parentTaskId, input: {} });
        ctx.tenantId = tenantId;
        ctx.agentId = parentAgentId;
        ctx.telemetry = { nodeId: 'parent-node', traceId: 'parent-trace' };

        await engineAccess.apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId: parentTaskId,
            agentId: parentAgentId,
            flushMentalState: async () => {},
        });

        const activeInbox = { current: [] as Observation[], all: [] as Observation[] };
        const iCtx = ctx as InternalTaskContext;
        iCtx.__activeLoopInbox = activeInbox;
        iCtx.__activeLoopEnv = { turn: 1, pending: { children: {} } };

        const dispatch = await ctx.sendTaskToAgent?.(
            childAgentId,
            { q: 1 },
            { awaitCompletion: false, timeout: 30_000 }
        );
        expect(isSendTaskDispatch(dispatch)).toBe(true);

        expect(activeInbox.current.filter((entry) => entry.kind === 'child.completed')).toHaveLength(0);

        const childTaskId = isSendTaskDispatch(dispatch) ? dispatch.handle?.id : undefined;
        expect(typeof childTaskId).toBe('string');
        if (typeof childTaskId !== 'string') {
            throw new Error('Expected child task id on returned task handle');
        }

        const childSnap = await engineAccess.sessionManager.load(tenantId, childTaskId);
        const childSnapshot = childSnap?.snapshot as SnapshotWithPending | undefined;
        const [toolToken] = Object.keys(childSnapshot?.pending?.tools ?? {});
        expect(typeof toolToken).toBe('string');
        if (typeof toolToken !== 'string') {
            throw new Error('Expected child snapshot to contain pending tool token');
        }

        await engine.handleToolCompleted({
            tenantId,
            taskId: childTaskId,
            token: toolToken,
            result: { status: 'ok', html: '<html>ok</html>' },
        });

        const parentSnap = await engineAccess.sessionManager.load(tenantId, parentTaskId);
        const parentSnapshot = parentSnap?.snapshot as { inbox?: { all?: Observation[] } } | undefined;
        const parentCompletions = (parentSnapshot?.inbox?.all ?? []).filter(
            (entry) => entry.kind === 'child.completed'
        );

        expect(parentCompletions).toHaveLength(1);
        expect(parentCompletions[0]?.payload).toMatchObject({
            token: dispatch.token,
            childTaskId,
            result: { status: 'done', html: '<html>ok</html>' },
            executionMetadata: { state: 'completed' },
        });
    });

    it('resumes an awaiting parent to terminal state after the async child completes', async () => {
        const tenantId = 't-a2a-parent-resume-repro';
        const parentAgentId = `parent-resume-${Date.now()}`;
        const childAgentId = `child-resume-${Date.now()}`;
        const parentTaskId = `parent-task-${Date.now()}`;
        const engine = new TaskEngine({});
        EngineLocator.setEngine(engine);

        PluginManager.registerAgent(createSuspendingChildPlugin(childAgentId, tenantId));
        PluginManager.registerAgent(createAwaitingParentPlugin(parentAgentId, childAgentId, tenantId));

        const engineAccess = engine as unknown as EngineAccess;
        const initialParent = await engineAccess.startTask({
            task: { id: parentTaskId, input: { q: 1 } },
            isStreaming: false,
            agentId: parentAgentId,
            tenantId,
        });
        const initialParentRecord = asRecord(initialParent);
        const initialStatus = asRecord(initialParentRecord?.status);
        expect(initialStatus?.state).toBe('working');

        const sessionInternals = engineAccess.sessionManager as unknown as TestSessionManagerInternals;
        const snapshots = sessionInternals.store?.snapshots;
        if (!snapshots) {
            throw new Error('Expected in-memory session snapshots to be available in test');
        }
        const childEntry = [...snapshots.entries()].find(([key, value]) => {
            const snapshot = value.snapshot as SnapshotWithPending | undefined;
            return (
                key.startsWith(`${tenantId}:`) &&
                value.agentId === childAgentId &&
                Object.keys(snapshot?.pending?.tools ?? {}).length > 0
            );
        });
        expect(childEntry).toBeDefined();
        if (!childEntry) {
            throw new Error('Expected child session snapshot');
        }

        const [childKey, childSnapshotRecord] = childEntry;
        const childTaskId = childKey.slice(`${tenantId}:`.length);
        const childSnapshot = childSnapshotRecord.snapshot as SnapshotWithPending | undefined;
        const childMeta = asRecord(childSnapshot?.meta);
        expect(childMeta?.a2aParent).toMatchObject({
            parentTenantId: tenantId,
            parentTaskId,
        });
        const [toolToken] = Object.keys(childSnapshot?.pending?.tools ?? {});
        expect(typeof toolToken).toBe('string');
        if (typeof toolToken !== 'string') {
            throw new Error('Expected child snapshot to contain pending tool token');
        }

        const staleChildCtx = engineAccess.createContext({ id: childTaskId, input: {} });
        LoopRegistry.__activeLoopContexts.set(childTaskId, staleChildCtx);
        await withTimeout(
            engine.handleToolCompleted({
                tenantId,
                taskId: childTaskId,
                token: toolToken,
                result: { status: 'ok', html: '<html>ok</html>' },
            }),
            2_000
        );
        LoopRegistry.__activeLoopContexts.delete(childTaskId);

        const parentSnap = await engineAccess.sessionManager.load(tenantId, parentTaskId);
        const parentStatus = asRecord(asRecord(parentSnap?.snapshot)?.status);
        const parentMeta = asRecord(asRecord(parentSnap?.snapshot)?.meta);
        const parentM = asRecord(asRecord(parentSnap?.snapshot)?.M);
        const parentMemory = asRecord(parentM?.memory);
        const parentSensory = asRecord(parentMemory?.sensory);

        expect(parentMeta?.awaiting).toBeUndefined();
        expect(parentSensory?.status).toBe('completed');
        expect(parentSensory?.content).toBe('<html>ok</html>');
        expect(parentStatus?.state).not.toBe('working');
    });
});
