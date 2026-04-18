import type { Modules } from '../loop/oneTurn.js';
import type { Observation } from '../types/observation.js';
import type { MentalState, EnvironmentState } from '../loop/types.js';
import type { TurnTrace } from '../types/turnTrace.js';
import { runLoop } from '../loop/loopRunner.js';
import { initialM } from '../loop/init.js';
import { normalizeObservationInbox } from '../loop/types.js';
import {
    HarnessConfigSchema,
    type HarnessConfig,
    type HarnessState,
    type DeepPartial,
    type TurnAssertionContext,
    type HarnessCommunicationManifestPatch,
} from './harnessTypes.js';
import { createDeterministicLLMStub, createDeterministicToolStub, type DeterministicLLMStub, type DeterministicToolStub } from './DeterministicStubs.js';
import { createTestContext } from './TestContext.js';
import { createTurnAssertionContext, HarnessAssertionError } from './HarnessAssertions.js';
import { InvariantError, ModuleExecutionError } from '../utils/errors.js';
import type { InternalTaskContext } from '../loop/internalContext.js';
import { TurnTraceCollector } from '../telemetry/TurnTraceCollector.js';
import type { TopicRef, TopicSelector } from '../public-types/conversation/types.js';
import type { InboundMessage } from '../public-types/conversation/types.js';
import type { TopicSelectorPolicy } from '../public-types/conversation/selectorPolicy.js';
import type { StopPolicyDefinition } from '../public-types/conversation/stopPolicy.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import type { MessageLog } from '../public-types/messageLog/types.js';
import { InviteSweeper } from '../internal/conversation/InviteSweeper.js';
import { InMemoryEventBus } from '../eventbus/inMemoryEventBus.js';
import { createBusEvent } from '../eventbus/busEventHelpers.js';
import { v7 as uuidv7 } from 'uuid';
import { EngineLocator } from '../orchestration/EngineLocator.js';
import type { TaskEngine } from '../orchestration/taskEngine.js';

export type TestHarness<Sensory = unknown> = {
    seedMentalState(m: DeepPartial<MentalState<Sensory>>): TestHarness<Sensory>;
    seedPending(pending: Partial<EnvironmentState['pending']>): TestHarness<Sensory>;
    seedControlVars(vars: Record<string, unknown>): TestHarness<Sensory>;
    seedConversationThread(params: {
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
    }): Promise<TestHarness<Sensory>>;

    injectObservation(obs: Observation): TestHarness<Sensory>;
    injectUserInput(value: unknown): TestHarness<Sensory>;
    injectToolCompleted(params: { token: string; tool: string; result?: unknown }): TestHarness<Sensory>;
    injectToolFailed(params: { token: string; tool: string; error?: unknown }): TestHarness<Sensory>;
    injectChildCompleted(params: { token: string; agentId: string; result?: unknown }): TestHarness<Sensory>;
    injectChildFailed(params: { token: string; agentId: string; error?: unknown }): TestHarness<Sensory>;

    /** Topic Phase 2 helpers — construct canonical `source: 'conversation'` observations. */
    injectTopicMessageReceived(params: {
        topic: TopicRef;
        selector: TopicSelector;
        message: InboundMessage;
    }): TestHarness<Sensory>;
    injectTopicMemberJoined(params: { topic: TopicRef; member: { agentId: string; role: 'owner' | 'participant' }; ts: string }): TestHarness<Sensory>;
    injectTopicMemberLeft(params: { topic: TopicRef; agentId: string; ts: string; reason?: string }): TestHarness<Sensory>;
    injectTopicClosed(params: { topic: TopicRef; ts: string; reason?: string }): TestHarness<Sensory>;

    /**
     * Register a topic selector policy on the harness `ConversationService` (same registry as `ctx.conversation` uses).
     */
    registerTopicSelectorPolicy(policy: TopicSelectorPolicy): TestHarness<Sensory>;
    /** Register a custom stop policy on the harness `ConversationService`. */
    registerStopPolicy(policy: StopPolicyDefinition): TestHarness<Sensory>;

    /**
     * Deep-merge a **`communication`** slice (as on `AgentRuntimeManifest`) into harness state.
     * Affects **`resolveThreadTtlMs`**, **`runLoop` `autoJoinInvitedTopics`**, and optional **`topicSweeper`**
     * when not overridden by **`HarnessConfig`**.
     */
    setCommunicationManifest(patch: HarnessCommunicationManifestPatch): TestHarness<Sensory>;
    /** Alias of **`setCommunicationManifest`** (capability-oriented naming). */
    setCommunicationCapabilities(patch: HarnessCommunicationManifestPatch): TestHarness<Sensory>;
    /** Route **`publishConversationEvent`** from the harness `ConversationService` through this bus. */
    useEventBusAdapter(bus: IEventBus): TestHarness<Sensory>;
    /** Replace the default session-backed **`MessageLog`** for **`ctx.conversation`**. */
    useMessageLogAdapter(log: MessageLog): TestHarness<Sensory>;
    /**
     * Reserved hook for future deterministic backpressure (Phase 5.4c+). Sets an internal flag only;
     * does not change behavior yet.
     */
    useDeterministicBackpressure(): TestHarness<Sensory>;
    /** Reserved for extension signal registry resets; no-op today. */
    resetSignalKindRegistry(): TestHarness<Sensory>;

    runTurn(): Promise<TestHarness<Sensory>>;

    expectTurn(fn: (t: TurnAssertionContext) => void): TestHarness<Sensory>;
    expectTurn(index: number, fn: (t: TurnAssertionContext) => void): TestHarness<Sensory>;
    expectComplete(): TestHarness<Sensory>;
    expectFail(): TestHarness<Sensory>;
    expectInvariantError(fn: (e: InvariantError) => void): TestHarness<Sensory>;
    expectModuleError(fn: (e: ModuleExecutionError) => void): TestHarness<Sensory>;

    lastTrace(): TurnTrace;
    lastAwaitToken(): string;
    allTraces(): readonly TurnTrace[];
    currentM(): Readonly<MentalState<Sensory>>;
    replies(): readonly unknown[];
    llmStub(): DeterministicLLMStub;
    toolStub(): DeterministicToolStub;

    /** Pin invite-related time for `ConversationService` / sweeper (ISO-8601). */
    setInviteClockNow(iso: string): TestHarness<Sensory>;
    triggerExpiredInviteSweep(params?: {
        tenantId?: string;
        nowIso?: string;
        limit?: number;
    }): Promise<string[]>;
    /** Republish undelivered invites to an in-memory bus (coordinator not subscribed unless you wire it). */
    runInviteStartupSweep(params?: { tenantId?: string; nowIso?: string; limit?: number }): Promise<string[]>;

    /**
     * Runs `ThreadLifecycleSweeper` via a registered `TaskEngine` (`EngineLocator.setEngine`).
     * Requires tests that need TTL expiry to register the engine first.
     */
    tickThreadLifecycleSweep(params?: {
        tenantId?: string;
        nowIso?: string;
        limit?: number;
        autoArchiveAfterMs?: number | null;
    }): Promise<{ expiredThreadIds: string[]; archivedThreadIds: string[] }>;
    /** Runs `TopicLifecycleSweeper` via a registered `TaskEngine` (`EngineLocator.setEngine`). */
    tickTopicLifecycleSweep(params?: {
        tenantId?: string;
        nowIso?: string;
        limit?: number;
        autoArchiveAfterMs?: number | null;
    }): Promise<{ archivedTopicIds: string[] }>;
};

// Deep merge utility
function isObject(item: unknown): item is Record<string, unknown> {
    return item !== null && typeof item === 'object' && !Array.isArray(item);
}

function mergeDeep(target: unknown, source: unknown): void {
    if (!isObject(target) || !isObject(source)) {
        return;
    }
    for (const key of Object.keys(source)) {
        const sk = source[key];
        const tk = target[key];
        if (isObject(tk) && isObject(sk)) {
            mergeDeep(tk, sk);
        } else {
            target[key] = sk;
        }
    }
}

function isBudgetTurnsExceeded(error: unknown): error is InvariantError {
    return error instanceof InvariantError && error.code === 'BUDGET_TURNS_EXCEEDED';
}

export function createTestHarness<
    Sensory = unknown,
    Obs = unknown,
    Alpha = unknown,
    ExecData = unknown,
    ExecError extends import('../loop/oneTurn.js').ExecErrorPayload = import('../loop/oneTurn.js').ExecErrorPayload
>(
    modules: Partial<Modules<Sensory, Obs, Alpha, ExecData, ExecError>>,
    config?: Partial<HarnessConfig>
): TestHarness<Sensory> {
    const configParsed = HarnessConfigSchema.parse(config || {});
    
    // Internal state
    const state: HarnessState<Sensory> = {
        m: {} as MentalState<Sensory>, // Filled below
        env: {
            time: new Date().toISOString(),
            sessionId: 'test-session',
            turn: 0,
            budget: { maxTurns: 100, latencyMs: 30000 },
            inbox: normalizeObservationInbox({ current: [], all: [] }),
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            control: undefined
        },
        inboxAll: [],
        traces: [],
        replies: [],
        errors: [],
        turnCount: 0,
        childDispatches: []
    };

    const llmStub = createDeterministicLLMStub();
    const toolStub = createDeterministicToolStub();

    const ctx = createTestContext(state, llmStub, toolStub, {
        policyPurityStrict: configParsed.policyPurityStrict,
    });
    
    // Seed initial MentalState
    state.m = initialM(ctx) as MentalState<Sensory>;

    const harness: TestHarness<Sensory> = {
        seedMentalState(mOverride) {
            mergeDeep(state.m, mOverride);
            return harness;
        },
        seedPending(pendingOverride) {
            mergeDeep(state.env.pending, pendingOverride);
            return harness;
        },
        seedControlVars(vars) {
            const iCtx = ctx as InternalTaskContext;
            iCtx.controlVars = iCtx.controlVars ?? {};
            mergeDeep(iCtx.controlVars, vars);
            const pending = state.env.pending;
            pending.controlVars = pending.controlVars ?? {};
            mergeDeep(pending.controlVars, vars);
            return harness;
        },
        async seedConversationThread(params) {
            if (!state.seedConversationThread) {
                throw new Error('seedConversationThread is not available on this harness');
            }
            await state.seedConversationThread(params);
            return harness;
        },

        injectObservation(obs) {
            const raw = { inbox: { current: [obs], all: [obs] } } as unknown as { inbox: unknown };
            const normalized = normalizeObservationInbox(raw.inbox);
            if (normalized.current.some(o => o.kind === 'validation.failed')) {
                state.env.inbox.current.push(...normalized.current);
            } else {
                state.env.inbox.current.push(obs);
            }
            return harness;
        },
        injectUserInput(value) {
            return harness.injectObservation({
                source: 'user',
                kind: 'input.provided',
                payload: { token: 'test-input-tok', value }
            });
        },
        injectToolCompleted(params) {
            return harness.injectObservation({
                source: 'tool',
                kind: 'tool.completed',
                payload: { token: params.token, tool: params.tool, result: params.result || {} }
            });
        },
        injectToolFailed(params) {
            return harness.injectObservation({
                source: 'tool',
                kind: 'tool.failed',
                payload: { token: params.token, tool: params.tool, error: { code: 'E1', message: String(params.error) } }
            });
        },
        injectChildCompleted(params) {
            return harness.injectObservation({
                source: 'child',
                kind: 'child.completed',
                payload: { token: params.token, agentId: params.agentId, result: params.result || {} }
            });
        },
        injectChildFailed(params) {
            return harness.injectObservation({
                source: 'child',
                kind: 'child.failed',
                payload: { token: params.token, agentId: params.agentId, error: { code: 'E1', message: String(params.error) } }
            });
        },
        injectTopicMessageReceived(params) {
            return harness.injectObservation({
                source: 'conversation',
                payload: {
                    kind: 'topic.message.received',
                    topic: params.topic,
                    selector: params.selector,
                    message: params.message,
                },
            } as Observation);
        },
        injectTopicMemberJoined(params) {
            return harness.injectObservation({
                source: 'conversation',
                payload: {
                    kind: 'topic.member.joined',
                    topic: params.topic,
                    member: params.member,
                    ts: params.ts,
                },
            } as Observation);
        },
        injectTopicMemberLeft(params) {
            return harness.injectObservation({
                source: 'conversation',
                payload: {
                    kind: 'topic.member.left',
                    topic: params.topic,
                    agentId: params.agentId,
                    ts: params.ts,
                    ...(params.reason !== undefined ? { reason: params.reason } : {}),
                },
            } as Observation);
        },
        injectTopicClosed(params) {
            return harness.injectObservation({
                source: 'conversation',
                payload: {
                    kind: 'topic.closed',
                    topic: params.topic,
                    ts: params.ts,
                    ...(params.reason !== undefined ? { reason: params.reason } : {}),
                },
            } as Observation);
        },

        registerTopicSelectorPolicy(policy) {
            const reg = state.harnessTopicSelectorPolicyRegistry;
            if (!reg) {
                throw new Error('TestHarness.registerTopicSelectorPolicy: harness conversation registries are not initialized');
            }
            reg.register(policy);
            return harness;
        },

        registerStopPolicy(policy) {
            const reg = state.harnessStopPolicyRegistry;
            if (!reg) {
                throw new Error('TestHarness.registerStopPolicy: harness conversation registries are not initialized');
            }
            reg.register(policy);
            return harness;
        },

        setCommunicationManifest(patch) {
            state.harnessCommunication = {
                ...(state.harnessCommunication ?? {}),
                ...patch,
                ...(patch.topicSweeper !== undefined
                    ? {
                          topicSweeper: {
                              ...(state.harnessCommunication?.topicSweeper ?? {}),
                              ...patch.topicSweeper,
                          },
                      }
                    : {}),
            };
            return harness;
        },

        setCommunicationCapabilities(patch) {
            return harness.setCommunicationManifest(patch);
        },

        useEventBusAdapter(bus) {
            state.harnessEventBus = bus;
            return harness;
        },

        useMessageLogAdapter(log) {
            state.harnessMessageLogOverride = log;
            return harness;
        },

        useDeterministicBackpressure() {
            state.harnessDeterministicBackpressure = true;
            return harness;
        },

        resetSignalKindRegistry() {
            return harness;
        },

        async runTurn() {
            state.errors.length = 0; // Clear errors locally for this turn
            
            const localCollector = new TurnTraceCollector();
            (ctx as InternalTaskContext).__turnTraceCollector = localCollector;

            try {
                if (state.pullPersistedConversationObservations) {
                    await state.pullPersistedConversationObservations();
                }
                const tw =
                    configParsed.topicSweeper !== undefined
                        ? configParsed.topicSweeper
                        : state.harnessCommunication?.topicSweeper;
                const topicSweeperOpts =
                    tw !== undefined
                        ? {
                              intervalMs: tw.intervalMs,
                              batchSize: tw.batchSize ?? 100,
                              autoArchiveAfterMs: tw.autoArchiveAfterMs,
                          }
                        : undefined;
                const autoJoinInvitedTopics =
                    configParsed.autoJoinInvitedTopics === true ||
                    state.harnessCommunication?.autoJoinInvitedTopics === true;
                const res = await runLoop(
                    ctx,
                    state.m,
                    state.env,
                    modules,
                    {
                        maxTurns: configParsed.maxTurns,
                        collectTraces: true,
                        autoJoinInvitedTopics,
                        ...(topicSweeperOpts !== undefined ? { topicSweeper: topicSweeperOpts } : {}),
                    }
                );
                
                state.m = res.M;

                if (process.env.CALLAGENT_DEBUG_HARNESS) {
                    const sensory = res.M.memory?.sensory;
                    const caseId =
                        sensory != null && typeof sensory === 'object' && 'caseId' in sensory
                            ? (sensory as { caseId?: unknown }).caseId
                            : undefined;
                    console.log(`[DEBUG_HARNESS] Turn ${state.turnCount} finished`, {
                        transition: res.outcome.kind,
                        stageAfter: localCollector.getLast()?.stageAfter,
                        hasSensory: sensory != null,
                        caseId,
                    });
                }
                const collected = localCollector.getAll();
                if (collected.length > 0) {
                    state.traces.push(...collected);
                } else if (res.outcome.kind === 'fail') {
                    // Synthesize a failed trace if loop failed before producing one
                    state.traces.push({
                        turn: state.turnCount + 1,
                        turnId: `test-turn-${state.turnCount + 1}`,
                        agentCardSource: 'inline',
                        runtimeManifestSource: 'inline',
                        agentCardHash: '',
                        runtimeManifestHash: '',
                        stageBefore: 'idle',
                        stageAfter: 'failed',
                        transition: { kind: 'fail', reason: res.outcome.reason },
                        inboxCurrent: [...state.env.inbox.current],
                        timings: { totalMs: 0 } as unknown as TurnTrace['timings'],
                    } as unknown as TurnTrace);
                }
                
                if (res.outcome.kind === 'fail' && 'error' in res.outcome && res.outcome.error) {
                    state.errors.push(res.outcome.error as Error);
                }
            } catch (err: unknown) {
                const collectedErr = localCollector.getAll();
                if (isBudgetTurnsExceeded(err) && collectedErr.length > 0) {
                    // state.m is already updated via the ctx.M setter (oneTurn sets iCtx.M = m1).
                    // Traces were collected before the budget throw; push them and continue.
                    state.traces.push(...collectedErr);
                    return harness;
                }
                state.errors.push(err instanceof Error ? err : new Error(String(err)));
                // Only synthesize if localCollector got nothing (e.g., threw before producing trace)
                if (collectedErr.length > 0) {
                    state.traces.push(...collectedErr);
                } else {
                    const turnId = `test-turn-${state.turnCount + 1}`;
                    state.traces.push({
                        turn: state.turnCount + 1,
                        turnId,
                        agentCardSource: 'inline',
                        runtimeManifestSource: 'inline',
                        agentCardHash: '',
                        runtimeManifestHash: '',
                        stageBefore: 'idle',
                        stageAfter: 'failed',
                        transition: { kind: 'fail', reason: 'harness_error' },
                        inboxCurrent: [...state.env.inbox.current],
                        timings: { totalMs: 0 } as unknown as TurnTrace['timings'],
                    } as unknown as TurnTrace);
                }
            } finally {
                state.turnCount++;
                const inboxSnapshot = [...state.env.inbox.current];
                state.inboxAll.push(...inboxSnapshot);
                // runLoop already places transition `continue` observations into env.inbox.current before
                // the local maxTurns budget throws. Clearing here would drop that feedback for the next
                // harness runTurn(); re-stage them when the trace shows continue.
                const lastTrace = localCollector.getLast();
                const keepContinueInbox =
                    lastTrace?.transition?.kind === 'continue' && inboxSnapshot.length > 0;
                state.env.inbox.current = keepContinueInbox ? inboxSnapshot : [];
                state.env.turn = (state.env.turn || 0) + 1;
            }

            return harness;
        },

        expectTurn(...args: [((t: TurnAssertionContext) => void)] | [number, (t: TurnAssertionContext) => void]) {
            const [index, fn] =
                args.length === 1
                    ? [undefined, args[0]]
                    : [args[0], args[1]];

            const trace = (() => {
                if (index == null) {
                    return harness.lastTrace();
                }
                if (!Number.isInteger(index) || index < 0) {
                    throw new Error(`expectTurn(index, fn): index must be a non-negative integer. Got ${String(index)}.`);
                }
                const selected = state.traces[index];
                if (!selected) {
                    throw new Error(
                        `expectTurn(index, fn): index ${index} is out of range. traces length=${state.traces.length}.`
                    );
                }
                return selected;
            })();
            const assertionCtx = createTurnAssertionContext(trace);
            fn(assertionCtx);
            return harness;
        },
        expectComplete() {
            const trace = harness.lastTrace();
            if (trace.transition?.kind !== 'complete') {
                throw new HarnessAssertionError('transition.kind', 'complete', trace.transition?.kind, trace.turn);
            }
            return harness;
        },
        expectFail() {
            const trace = harness.lastTrace();
            if (trace.transition?.kind !== 'fail') {
                throw new HarnessAssertionError('transition.kind', 'fail', trace.transition?.kind, trace.turn);
            }
            return harness;
        },
        expectInvariantError(fn) {
            const lastError = state.errors[state.errors.length - 1];
            if (!lastError || !(lastError instanceof InvariantError)) {
                throw new Error(`Expected an InvariantError but got ${lastError?.constructor.name || 'nothing'}`);
            }
            fn(lastError);
            return harness;
        },
        expectModuleError(fn) {
            const lastError = state.errors[state.errors.length - 1];
            if (!lastError || !(lastError instanceof ModuleExecutionError)) {
                throw new Error(`Expected a ModuleExecutionError but got ${lastError?.constructor.name || 'nothing'}`);
            }
            fn(lastError);
            return harness;
        },

        lastTrace() {
            if (state.traces.length === 0) {
                throw new Error('No traces available. Call runTurn() first.');
            }
            return state.traces[state.traces.length - 1];
        },
        lastAwaitToken() {
            const trace = harness.lastTrace();
            const token = trace.transition?.token;
            if (!token) {
                throw new Error(`No await token found in transition of kind '${trace.transition?.kind}'`);
            }
            return token;
        },
        allTraces() {
            return Object.freeze([...state.traces]);
        },
        currentM() {
            return Object.freeze({ ...state.m });
        },
        replies() {
            return Object.freeze([...state.replies]);
        },
        llmStub() {
            return llmStub;
        },
        toolStub() {
            return toolStub;
        },

        setInviteClockNow(iso: string) {
            const ms = Date.parse(iso);
            if (Number.isNaN(ms)) {
                throw new Error(`setInviteClockNow: invalid ISO date: ${iso}`);
            }
            state.inviteClockNowMs = ms;
            return harness;
        },

        async triggerExpiredInviteSweep(params) {
            const sm = state.conversationSessionManager;
            const clock = state.inviteClock;
            if (!sm || !clock) {
                throw new Error('TestHarness: conversation session store not initialized');
            }
            const sweeper = new InviteSweeper(sm, clock);
            return sweeper.runExpirySweep({
                tenantId: params?.tenantId ?? state.conversationTenantId ?? 'test-tenant',
                nowIso: params?.nowIso,
                limit: params?.limit,
            });
        },

        async runInviteStartupSweep(params) {
            const sm = state.conversationSessionManager;
            const clock = state.inviteClock;
            if (!sm || !clock) {
                throw new Error('TestHarness: conversation session store not initialized');
            }
            const bus = new InMemoryEventBus();
            const sweeper = new InviteSweeper(sm, clock);
            return sweeper.runStartupRecoverySweep({
                tenantId: params?.tenantId ?? state.conversationTenantId ?? 'test-tenant',
                publish: async (channel, event) => {
                    await bus.publish(
                        createBusEvent({
                            channel,
                            cloud: {
                                id: uuidv7(),
                                type: channel,
                                source: '/conversation/events',
                                time: new Date().toISOString(),
                                datacontenttype: 'application/json',
                                data: event,
                            },
                        })
                    );
                },
                nowIso: params?.nowIso,
                limit: params?.limit,
            });
        },

        async tickThreadLifecycleSweep(params) {
            const eng = EngineLocator.getEngine<TaskEngine>();
            if (!eng?.triggerThreadLifecycleSweep) {
                throw new Error(
                    'TestHarness.tickThreadLifecycleSweep: register a TaskEngine with EngineLocator.setEngine(engine) first'
                );
            }
            return eng.triggerThreadLifecycleSweep({
                tenantId: params?.tenantId ?? state.conversationTenantId ?? 'test-tenant',
                nowIso: params?.nowIso,
                limit: params?.limit,
                autoArchiveAfterMs: params?.autoArchiveAfterMs,
            });
        },

        async tickTopicLifecycleSweep(params) {
            const eng = EngineLocator.getEngine<TaskEngine>();
            if (!eng?.triggerTopicLifecycleSweep) {
                throw new Error(
                    'TestHarness.tickTopicLifecycleSweep: register a TaskEngine with EngineLocator.setEngine(engine) first'
                );
            }
            return eng.triggerTopicLifecycleSweep({
                tenantId: params?.tenantId ?? state.conversationTenantId ?? 'test-tenant',
                nowIso: params?.nowIso,
                limit: params?.limit,
                autoArchiveAfterMs: params?.autoArchiveAfterMs,
            });
        },
    };

    return harness;
}
