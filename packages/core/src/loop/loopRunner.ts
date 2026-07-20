import type { TaskContext, TaskInput } from '../shared/types/index.js';
import {
    oneTurn,
    type Modules,
    type TurnOutcome,
    type TransitionOut,
    type ExecOutcome,
    type ExecResult,
    type ExecErrorPayload,
    type AttentionSignal,
    type Observation
} from './oneTurn.js';
import type { Intent, ExecutableAction } from '../types/intent.js';
import {
    LLMRespondedPayloadSchema,
    ValidationFailedPayloadSchema,
} from '../types/observation.js';
import { normalizeObservationInbox, type EnvironmentState, type MentalState, type ObservationInbox } from './types.js';
import { logger, updateLoggingContext } from '@a2arium/callagent-utils';
import { TurnNode } from '../telemetry/nodes/TurnNode.js';
import { WorkflowNode } from '../telemetry/nodes/WorkflowNode.js';
import { telemetry } from '../telemetry/TelemetryCollector.js';
import { Plan, PlanState, PlanStep, PlanId, PlanSchema } from '../types/plan.js';
import { throwInvariantError } from '../utils/invariantError.js';
import { InvariantError } from '../utils/errors.js';
import { isTaskLifecycleTerminalError } from '@a2arium/callagent-types/task-lifecycle-terminal';
import { isTaskTurnSupersededError } from '@a2arium/callagent-types/task-turn-superseded';
import type { InternalTaskContext, OperatorMemoryEvent } from './internalContext.js';
import type { TurnTrace, ManifestProvenance, TurnTimings, TurnUsage } from '../types/turnTrace.js';
import { TurnTraceSchema } from '../types/turnTrace.js';
import { summarizePending, aggregateUsage, compactModuleOutput } from '../telemetry/turnTraceHelpers.js';
import { generateCorrelationId } from '../tracing/Tracing.js';
import { v7 as uuidv7 } from 'uuid';
import { TurnTraceCollector } from '../telemetry/TurnTraceCollector.js';
import { reduceConversationProjection } from './learning/conversationReducer.js';
import { runDefaultAutoJoinInvitedTopics } from '../policy/defaultAutoJoinPolicy.js';
import { EngineLocator } from '../orchestration/EngineLocator.js';
import { currentSegmentIdempotencyKey, currentTaskTurnClaim } from '../runtime/segmentProcessedKeys.js';
import {
    conversationInboxDeliveryKey,
    conversationInboxDeliveryKeyFromTurnSummary,
} from './conversationInboxIdentity.js';

const log = logger.createLogger({ prefix: 'runLoop' });

/**
 * Ownership loss is an admission result, not an application failure. Module
 * boundaries wrap provider/effect errors, so preserve these typed causes for
 * the segment executor to prove against the latest durable snapshot.
 */
function hasTaskTurnOwnershipLossCause(error: unknown): boolean {
    const seen = new Set<object>();
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
        if (isTaskTurnSupersededError(current) || isTaskLifecycleTerminalError(current)) return true;
        if (typeof current !== 'object' || seen.has(current)) return false;
        seen.add(current);
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

/** Walk telemetry parents and ctx so TurnNode keeps the session trace id across async boundaries. */
function resolveTraceIdForTurnParent(
    parentId: string | undefined,
    ctx: TaskContext
): string | undefined {
    if (parentId) {
        const seen = new Set<string>();
        let pid: string | undefined = parentId;
        while (pid && pid !== 'root' && !seen.has(pid)) {
            seen.add(pid);
            const p = telemetry.getNode(pid);
            if (p?.traceId) return p.traceId;
            pid = p?.parentId;
        }
    }
    const tid = ctx.telemetry?.traceId;
    return typeof tid === 'string' && tid.length > 0 ? tid : undefined;
}

type LoopRunnerOptions = {
    maxTurns?: number;
    latencyMs?: number;
    manifestProvenance?: ManifestProvenance;
    collectTraces?: boolean;
    autoJoinInvitedTopics?: boolean;
    hitl?: import('./manifestConsent.js').ManifestHitlConfig;
    onTurnCheckpoint?: (state: {
        M: MentalState;
        env: EnvironmentState;
        outcome: TurnOutcome;
        consumedConversationMessageKeys: ReadonlySet<string>;
    }) => Promise<void>;
    /** When set with a registered `TaskEngine`, `runLoop` invokes `triggerTopicLifecycleSweep` when `intervalMs` of wall time has elapsed since the last sweep (checked between turns). */
    topicSweeper?: {
        intervalMs: number;
        batchSize: number;
        autoArchiveAfterMs: number;
    };
};

const DEFAULT_PROVENANCE: ManifestProvenance = {
    agentCardSource: 'inline',
    runtimeManifestSource: 'inline',
    agentCardHash: '',
    runtimeManifestHash: '',
};

const ensureInbox = (environment: EnvironmentState): ObservationInbox => {
    const normalized = normalizeObservationInbox(environment.inbox);
    environment.inbox = normalized;
    return normalized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

type OperatorEventSink = {
    appendOperatorEvent: (params: {
        tenantId: string;
        sessionId: string;
        type: string;
        payload: Record<string, unknown>;
    }) => Promise<{ eventId: string; seq: number } | undefined>;
};

const OPERATOR_SUMMARY_STRING_CHARS = 1_000;
const OPERATOR_FULL_STRING_CHARS = 2_000;
const OPERATOR_SUMMARY_ARRAY_ITEMS = 20;
const OPERATOR_FULL_ARRAY_ITEMS = 100;

function resolveOperatorEventSink(): OperatorEventSink | undefined {
    const engine = EngineLocator.getEngine<Partial<OperatorEventSink>>();
    return typeof engine?.appendOperatorEvent === 'function'
        ? { appendOperatorEvent: engine.appendOperatorEvent.bind(engine) }
        : undefined;
}

function isOperatorCaptureEnabled(ctx: InternalTaskContext): boolean {
    return ctx.__operatorTurnTraceCapture?.enabled !== false;
}

function operatorCaptureLevel(ctx: InternalTaskContext): 'summary' | 'full' {
    return ctx.__operatorTurnTraceCapture?.level === 'full' ? 'full' : 'summary';
}

function compactOperatorValue(value: unknown, level: 'summary' | 'full', depth = 0): unknown {
    const maxDepth = level === 'full' ? 6 : 6;
    const maxStringChars = level === 'full' ? OPERATOR_FULL_STRING_CHARS : OPERATOR_SUMMARY_STRING_CHARS;
    const maxArrayItems = level === 'full' ? OPERATOR_FULL_ARRAY_ITEMS : OPERATOR_SUMMARY_ARRAY_ITEMS;

    if (depth > maxDepth) {
        return '[truncated]';
    }
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        return value.length <= maxStringChars
            ? value
            : `${value.slice(0, maxStringChars)}... [truncated ${value.length} chars]`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (Array.isArray(value)) {
        const items = value
            .slice(0, maxArrayItems)
            .map((item) => compactOperatorValue(item, level, depth + 1));
        return value.length > maxArrayItems
            ? [...items, `... [truncated ${value.length - maxArrayItems} array items]`]
            : items;
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const artifact = compactOperatorArtifact(record);
        if (artifact !== undefined) {
            return artifact;
        }
        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(record)) {
            const compact = compactOperatorValue(entry, level, depth + 1);
            if (compact !== undefined) {
                output[key] = compact;
            }
        }
        return output;
    }
    return String(value);
}

function compactOperatorArtifact(value: Record<string, unknown>): Record<string, unknown> | undefined {
    const kind = typeof value.kind === 'string' ? value.kind : undefined;
    if (kind === 'artifact_local') {
        return value;
    }
    if (kind !== 'artifact' && value.state !== 'artifact_only') {
        return undefined;
    }
    const artifactId =
        typeof value.id === 'string'
            ? value.id
            : typeof value.artifactId === 'string'
                ? value.artifactId
                : kind === 'artifact_local'
                    ? 'local'
                    : 'unknown';
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : undefined;
    const estimatedSize =
        typeof value.estimatedSize === 'number'
            ? value.estimatedSize
            : typeof value.size === 'number'
                ? value.size
                : kind === 'artifact_local' && typeof value.value === 'string'
                    ? value.value.length
                    : undefined;
    return {
        state: 'artifact_only',
        artifactId,
        summary: artifactId === 'local'
            ? 'Local artifact'
            : artifactId === 'unknown'
                ? 'Artifact reference'
                : `Artifact ${artifactId}`,
        ...(mimeType ? { mimeType } : {}),
        ...(estimatedSize !== undefined ? { estimatedSize } : {}),
    };
}

async function appendOperatorEvent(
    ctx: TaskContext,
    type: string,
    payload: Record<string, unknown>
): Promise<void> {
    const sink = resolveOperatorEventSink();
    if (sink === undefined) {
        return;
    }
    await sink.appendOperatorEvent({
        tenantId: ctx.tenantId,
        sessionId: ctx.task.id,
        type,
        payload,
    });
}

async function appendOperatorTurnEvent(ctx: TaskContext, trace: TurnTrace): Promise<void> {
    const internal = ctx as InternalTaskContext;
    if (!isOperatorCaptureEnabled(internal)) {
        return;
    }
    if (currentTaskTurnClaim() !== undefined) {
        internal.__pendingOperatorTurnTraces = [...(internal.__pendingOperatorTurnTraces ?? []), trace];
        return;
    }
    await appendOperatorTurnTraceProjection(ctx, trace, 'turn.completed');
}

async function appendOperatorTurnTraceProjection(
    ctx: TaskContext,
    trace: TurnTrace,
    type: 'turn.completed' | 'turn.superseded'
): Promise<void> {
    const internal = ctx as InternalTaskContext;
    const level = operatorCaptureLevel(internal);
    const claim = currentTaskTurnClaim();
    await appendOperatorEvent(ctx, type, {
        taskId: ctx.task.id,
        agentId: ctx.agentId,
        turnSeq: trace.turn,
        turnId: trace.turnId,
        stageBefore: trace.stageBefore,
        stageAfter: trace.stageAfter,
        stageTransition: trace.stageTransition,
        transition: compactOperatorValue(trace.transition, level),
        intent: compactOperatorValue(trace.intent, level),
        shield: compactOperatorValue(trace.shield, level),
        manifestConsent: compactOperatorValue(trace.manifestConsent, level),
        perception: compactOperatorValue(trace.perception, level),
        execAction: compactOperatorValue(trace.execAction, level),
        execResult: compactOperatorValue(trace.execResult, level),
        timings: trace.timings,
        usage: trace.usage,
        llmCalls: compactOperatorValue(trace.llmCalls ?? [], level),
        toolCalls: compactOperatorValue(trace.toolCalls ?? [], level),
        childCalls: compactOperatorValue(trace.childCalls ?? [], level),
        pendingAfter: trace.pendingAfter,
        mentalStateBeforeHash: trace.mentalStateBeforeHash,
        mentalStateAfterHash: trace.mentalStateAfterHash,
        traceId: trace.traceId,
        spanId: trace.spanId,
        parentSpanId: trace.parentSpanId,
        ...(claim ? {
            claimId: claim.claimId,
            fence: claim.fence,
            claimedGeneration: claim.claimedGeneration,
            logicalTurnSeq: claim.turnSeq,
            attemptKey: currentSegmentIdempotencyKey(),
        } : {}),
        level,
    });
}

export async function flushBufferedOperatorTurnEvents(
    ctx: TaskContext,
    disposition: 'committed' | 'superseded'
): Promise<void> {
    const internal = ctx as InternalTaskContext;
    const traces = internal.__pendingOperatorTurnTraces ?? [];
    internal.__pendingOperatorTurnTraces = undefined;
    for (const trace of traces) {
        try {
            await appendOperatorTurnTraceProjection(
                ctx,
                trace,
                disposition === 'committed' ? 'turn.completed' : 'turn.superseded'
            );
        } catch (error) {
            log.debug('Failed to append post-arbitration operator turn event', {
                disposition,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

async function appendOperatorTurnStartedEvent(
    ctx: TaskContext,
    turnSeq: number,
    turnId?: string,
    traceId?: string,
    spanId?: string
): Promise<void> {
    const internal = ctx as InternalTaskContext;
    if (!isOperatorCaptureEnabled(internal)) {
        return;
    }
    await appendOperatorEvent(ctx, 'turn.started', {
        taskId: ctx.task.id,
        agentId: ctx.agentId,
        turnSeq,
        ...(turnId ? { turnId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(spanId ? { spanId } : {}),
        ...(currentTaskTurnClaim() ? {
            claimId: currentTaskTurnClaim()!.claimId,
            fence: currentTaskTurnClaim()!.fence,
            claimedGeneration: currentTaskTurnClaim()!.claimedGeneration,
            logicalTurnSeq: currentTaskTurnClaim()!.turnSeq,
            attemptKey: currentSegmentIdempotencyKey(),
        } : {}),
    });
}

async function appendOperatorMemoryEvent(
    ctx: TaskContext,
    event: OperatorMemoryEvent
): Promise<void> {
    const internal = ctx as InternalTaskContext;
    const hasPayload = event.keys.length > 0 || (event.resultKeys?.length ?? 0) > 0 || event.query !== undefined;
    if (!isOperatorCaptureEnabled(internal) || !hasPayload) {
        return;
    }
    await appendOperatorEvent(ctx, `memory.${event.op}`, {
        taskId: ctx.task.id,
        agentId: event.agentId ?? ctx.agentId,
        turnSeq: event.turnSeq,
        op: event.op,
        keys: event.keys.slice(0, 100),
        keyCount: event.keys.length,
        ...(event.query !== undefined ? { query: compactOperatorValue(event.query, operatorCaptureLevel(internal)) } : {}),
        ...(event.resultKeys ? { resultKeys: event.resultKeys.slice(0, 100) } : {}),
        ...(event.resultCount !== undefined ? { resultCount: event.resultCount } : {}),
        ...(event.status ? { status: event.status } : {}),
        backend: event.backend,
        source: event.source,
        traceId: ctx.telemetry?.traceId,
        spanId: ctx.telemetry?.nodeId,
    });
}

function semanticReadKeys(query: {
    id?: string | string[];
    tag?: string;
    tags?: string[];
    limit?: number;
}): string[] {
    if (typeof query.id === 'string') {
        return [query.id];
    }
    if (Array.isArray(query.id)) {
        return query.id;
    }
    return [];
}

function semanticQuerySummary(query: unknown): unknown {
    if (typeof query === 'string') {
        return { pattern: query };
    }
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
        return query ?? {};
    }
    const raw = query as Record<string, unknown>;
    return {
        ...(raw.id !== undefined ? { id: raw.id } : {}),
        ...(raw.tag !== undefined ? { tag: raw.tag } : {}),
        ...(raw.tags !== undefined ? { tags: raw.tags } : {}),
        ...(raw.filters !== undefined ? { filters: raw.filters } : {}),
        ...(raw.limit !== undefined ? { limit: raw.limit } : {}),
        ...(raw.orderBy !== undefined ? { orderBy: raw.orderBy } : {}),
        ...(raw.random !== undefined ? { random: raw.random } : {}),
        ...(raw.backend !== undefined ? { backend: raw.backend } : {}),
    };
}

function semanticResultKeys(results: unknown): string[] {
    if (!Array.isArray(results)) return [];
    return results
        .map((item) => {
            if (item && typeof item === 'object') {
                const record = item as Record<string, unknown>;
                if (typeof record.key === 'string') return record.key;
                if (typeof record.id === 'string') return record.id;
            }
            return undefined;
        })
        .filter((key): key is string => key !== undefined);
}

function usageFromTurnCalls(iCtx: InternalTaskContext): TurnUsage | undefined {
    const llmCalls = iCtx.__turnLlmCalls ?? [];
    const toolCallCount = iCtx.__turnToolCalls?.length ?? 0;
    const childCallCount = iCtx.__turnChildCalls?.length ?? 0;
    const hasUsageData =
        llmCalls.length > 0 ||
        toolCallCount > 0 ||
        childCallCount > 0 ||
        iCtx.__turnUsage !== undefined;
    if (!hasUsageData) {
        return undefined;
    }
    const aggregate = llmCalls.length > 0
        ? aggregateUsage(llmCalls.map((call) => ({
              usage: {
                  inputTokens: call.inputTokens,
                  outputTokens: call.outputTokens,
                  totalTokens:
                      call.inputTokens !== undefined || call.outputTokens !== undefined
                          ? (call.inputTokens ?? 0) + (call.outputTokens ?? 0)
                          : undefined,
              },
              pricing: {
                  cost: call.cost ?? 0,
                  currency: 'USD',
              },
          })))
        : undefined;

    return {
        ...(aggregate ?? {}),
        ...(iCtx.__turnUsage ?? {}),
        ...(llmCalls.length > 0 ? { llmCalls: llmCalls.length } : {}),
        ...(toolCallCount > 0 ? { toolCalls: toolCallCount } : {}),
        ...(childCallCount > 0 ? { childCalls: childCallCount } : {}),
    };
}

export async function runLoop<
    Sensory = unknown,
    Obs = Observation,
    Alpha = AttentionSignal,
    ExecData = unknown,
    ExecError extends import('./oneTurn.js').ExecErrorPayload = import('./oneTurn.js').ExecErrorPayload
>(
    ctx: TaskContext,
    M: MentalState<Sensory>,
    env: EnvironmentState,
    modules: Partial<Modules<Sensory, Obs, Alpha, ExecData, ExecError>>,
    opts: LoopRunnerOptions = {}
): Promise<{
    M: MentalState<Sensory>;
    outcome: TurnOutcome;
    metrics?: { timings: Record<string, number>[]; rewards: number[] };
    traces?: TurnTrace[];
}> {
    const iCtx = ctx as InternalTaskContext;
    const runId = Math.random().toString(36).substring(2, 8);
    const taskId = ctx.task.id.substring(0, 20);
    const sessionId = ctx.task?.id ?? taskId;
    log.debug('runLoop started', { taskId, runId });

    const start = Date.now();
    const maxTurns = opts.maxTurns ?? Infinity; // no default - respect manifest values
    try {
        log.info('LoopRunner started', { maxTurns, latencyMs: opts.latencyMs, taskId });
    } catch {
        /* noop */
    }

    const inbox = ensureInbox(env);

    try {
        (env as EnvironmentState).control = {
            pendingSnapshot: env.pending as import('./types.js').ControlPendingState,
            lastExec: env.lastExec,
        };
    } catch { /* noop */ }

    Object.defineProperty(ctx, '__activeLoopInbox', {
        get: () => env.inbox,
        configurable: true,
    });
    iCtx.__activeLoopEnv = env;
    iCtx.__manifestHitl = opts.hitl;

    const provenance = opts.manifestProvenance ?? iCtx.__manifestProvenance ?? DEFAULT_PROVENANCE;
    const collectTraces = opts.collectTraces ?? false;
    const collector = collectTraces ? (iCtx.__turnTraceCollector ?? new TurnTraceCollector()) : undefined;
    if (collectTraces && collector && !iCtx.__turnTraceCollector) {
        iCtx.__turnTraceCollector = collector;
    }

    // log.info('LoopRunner: Attached __activeLoopInbox to context (v3.5)', { taskId, hasInbox: !!inbox, inboxLen: inbox.current.length });

    const createMemoryReader = (mState: MentalState<Sensory>): import('./types.js').MemoryReader => {
        const semanticRegistry = (ctx as any).memory?.semantic;
        const normalizeSemantic = (raw: any): import('./types.js').SemanticConcept => ({
            id: raw?.id ?? raw?.key ?? '',
            data: raw?.value ?? raw?.data,
            embedding: (raw as any)?.embedding,
            source: (raw as any)?.source
        });
        return {
            semantic: {
                read: async (q) => {
                    if (semanticRegistry?.read) {
                        const res = await semanticRegistry.read(q);
                        const resultKeys = semanticResultKeys(res);
                        try {
                            await appendOperatorMemoryEvent(ctx, {
                                op: 'read',
                                keys: semanticReadKeys(q),
                                query: semanticQuerySummary(q),
                                resultKeys,
                                resultCount: Array.isArray(res) ? res.length : 0,
                                status: 'success',
                                backend: 'semantic',
                                turnSeq: env.turn,
                                agentId: ctx.agentId,
                                source: 'loop.memory',
                            });
                        } catch (eventErr) {
                            log.debug('Failed to append operator memory.read event', {
                                error: eventErr instanceof Error ? eventErr.message : String(eventErr),
                            });
                        }
                        return Array.isArray(res) ? res.map(normalizeSemantic) : [];
                    }
                    const concepts = (mState as any)?.memory?.longTerm?.semantic?.concepts || [];
                    if (!q || (!q.id && !q.tag && !q.tags)) {
                        try {
                            await appendOperatorMemoryEvent(ctx, {
                                op: 'read',
                                keys: [],
                                query: semanticQuerySummary(q),
                                resultKeys: semanticResultKeys(concepts),
                                resultCount: concepts.length,
                                status: 'success',
                                backend: 'semantic',
                                turnSeq: env.turn,
                                agentId: ctx.agentId,
                                source: 'loop.memory',
                            });
                        } catch { /* noop */ }
                        return concepts;
                    }
                    const ids = q.id ? (Array.isArray(q.id) ? q.id : [q.id]) : undefined;
                    const filtered = concepts.filter((c: any) => (!ids || ids.includes(c.id)));
                    try {
                        await appendOperatorMemoryEvent(ctx, {
                            op: 'read',
                            keys: semanticReadKeys(q),
                            query: semanticQuerySummary(q),
                            resultKeys: semanticResultKeys(filtered),
                            resultCount: filtered.length,
                            status: 'success',
                            backend: 'semantic',
                            turnSeq: env.turn,
                            agentId: ctx.agentId,
                            source: 'loop.memory',
                        });
                    } catch { /* noop */ }
                    return filtered;
                },
                get: async (id) => {
                    const res = await (semanticRegistry?.read ? semanticRegistry.read(id) : undefined);
                    const resultKeys = semanticResultKeys(res);
                    try {
                        await appendOperatorMemoryEvent(ctx, {
                            op: 'read',
                            keys: [id],
                            query: { id },
                            resultKeys,
                            resultCount: Array.isArray(res) ? res.length : 0,
                            status: 'success',
                            backend: 'semantic',
                            turnSeq: env.turn,
                            agentId: ctx.agentId,
                            source: 'loop.memory',
                        });
                    } catch (eventErr) {
                        log.debug('Failed to append operator memory.read event', {
                            error: eventErr instanceof Error ? eventErr.message : String(eventErr),
                        });
                    }
                    if (Array.isArray(res) && res.length > 0) return normalizeSemantic(res[0]);
                    const concepts = (mState as any)?.memory?.longTerm?.semantic?.concepts || [];
                    return concepts.find((c: any) => c.id === id) || null;
                }
            },
            episodic: {
                range: async (opts) => {
                    const events = (mState as any)?.memory?.longTerm?.episodic || [];
                    if (!opts) return events;
                    const filtered = events.filter((e: any) => {
                        const okFrom = opts.from === undefined || e.t >= opts.from;
                        const okTo = opts.to === undefined || e.t <= opts.to;
                        return okFrom && okTo;
                    });
                    return typeof opts.limit === 'number' ? filtered.slice(-opts.limit) : filtered;
                }
            },
            procedural: { list: async () => (mState as any)?.memory?.longTerm?.procedural?.skills || [] },
            world: { get: async () => mState.worldModel ?? {} },
            goals: { get: async () => (mState as any)?.goalState?.hierarchy || { nodes: {}, roots: [] } },
            policy: { getParams: async () => (mState as any)?.policyParams },
            reward: { getParams: async () => (mState as any)?.rewardParams },
            plans: { get: async () => (mState as any)?.plans || { plans: {}, activePlanId: undefined } }
        };
    };

    const createMemoryWriter = () => {
        const patches = {
            semanticUpserts: new Map<string, import('./types.js').SemanticConcept>(),
            semanticDeletes: new Set<string>(),
            episodicAppends: [] as import('./types.js').EpisodicEvent[],
            proceduralReplace: undefined as import('./types.js').Skill[] | undefined,
            worldReplace: undefined as import('./types.js').WorldModel | undefined,
            goalsReplace: undefined as import('./types.js').GoalHierarchy | undefined,
            policyParamsReplace: undefined as import('./types.js').MentalState['policyParams'] | undefined,
            rewardParamsReplace: undefined as import('./types.js').MentalState['rewardParams'] | undefined,
            plansReplace: undefined as import('../types/plan.js').PlanState | undefined,
            planUpserts: new Map<string, import('../types/plan.js').Plan>(),
            planStepUpdates: new Map<string, { planId: string, stepId: string, patch: Partial<import('../types/plan.js').PlanStep> }>()
        };

        const writer: import('./types.js').MemoryWriter & {
            __drain: () => typeof patches;
            __applyToMental: (m: MentalState<Sensory>) => MentalState<Sensory>;
        } = {
            semantic: {
                add: (item) => {
                    patches.semanticDeletes.delete(item.id);
                    patches.semanticUpserts.set(item.id, item);
                },
                delete: (id) => {
                    patches.semanticUpserts.delete(id);
                    patches.semanticDeletes.add(id);
                }
            },
            episodic: { append: (e) => { patches.episodicAppends.push(e); } },
            procedural: { set: (skills) => { patches.proceduralReplace = skills; } },
            world: { set: (wm) => { patches.worldReplace = wm; } },
            goals: {
                set: (g) => { patches.goalsReplace = g; },
                add: (node) => {
                    const current = patches.goalsReplace;
                    if (current) {
                        const nodes = { ...current.nodes, [node.id]: node };
                        const roots = current.roots.includes(node.id) ? current.roots : [...current.roots, node.id];
                        patches.goalsReplace = { ...current, nodes, roots };
                    }
                },
                update: (id, patch) => {
                    const current = patches.goalsReplace;
                    if (current?.nodes?.[id]) {
                        patches.goalsReplace = {
                            ...current,
                            nodes: { ...current.nodes, [id]: { ...current.nodes[id], ...patch } }
                        };
                    }
                },
                remove: (id) => {
                    const current = patches.goalsReplace;
                    if (current?.nodes?.[id]) {
                        const nodes = { ...current.nodes };
                        delete nodes[id];
                        const roots = current.roots.filter(r => r !== id);
                        patches.goalsReplace = { ...current, nodes, roots };
                    }
                },
                clear: (predicate) => {
                    const current = patches.goalsReplace;
                    if (current) {
                        const nodes = Object.fromEntries(
                            Object.entries(current.nodes).filter(([_, v]) =>
                                predicate ? predicate(v) : false
                            )
                        );
                        const roots = current.roots.filter(r => !!nodes[r]);
                        patches.goalsReplace = { ...current, nodes, roots };
                    }
                }
            },
            plans: {
                set: (s: PlanState) => { patches.plansReplace = s; },
                add: (p: Plan) => { patches.planUpserts.set(p.id, p); },
                update: (id: PlanId, patch: Partial<Plan>) => {
                    const current = patches.planUpserts.get(id);
                    if (current) patches.planUpserts.set(id, { ...current, ...patch });
                },
                updateStep: (planId: PlanId, stepId: string, patch: Partial<PlanStep>) => {
                    patches.planStepUpdates.set(`${planId}:${stepId}`, { planId, stepId, patch });
                },
                remove: (id: PlanId) => { /* logic to remove if needed */ }
            },
            policy: { setParams: (p) => { patches.policyParamsReplace = p; } },
            reward: { setParams: (p) => { patches.rewardParamsReplace = p; } },
            __applyToMental: (m: MentalState<Sensory>) => {
                const next = { ...(m as any) } as MentalState<Sensory>;
                next.memory = { ...(next as any).memory };
                next.memory.longTerm = { ...(next as any).memory.longTerm };
                // Episodic
                const episodic = Array.isArray((next as any).memory.longTerm.episodic)
                    ? [...(next as any).memory.longTerm.episodic]
                    : [];
                patches.episodicAppends.forEach(e => episodic.push(e));
                (next as any).memory.longTerm.episodic = episodic;
                // Semantic
                const existingSem = Array.isArray((next as any).memory.longTerm.semantic?.concepts)
                    ? [...(next as any).memory.longTerm.semantic.concepts]
                    : [];
                const semMap = new Map<string, any>(existingSem.map((c: any) => [c.id, c]));
                patches.semanticUpserts.forEach((val, key) => semMap.set(key, val));
                patches.semanticDeletes.forEach((id) => semMap.delete(id));
                (next as any).memory.longTerm.semantic = { concepts: Array.from(semMap.values()) };
                // Procedural/world/goals/policy/reward
                if (patches.proceduralReplace) {
                    (next as any).memory.longTerm.procedural = { skills: patches.proceduralReplace };
                }
                if (patches.worldReplace) (next as MentalState).worldModel = patches.worldReplace;
                if (patches.goalsReplace) (next as any).goalState = { ...(next as any).goalState, hierarchy: patches.goalsReplace };
                if (patches.plansReplace) (next as any).plans = patches.plansReplace;
                if (patches.planUpserts.size > 0) {
                    const plans = { ...((next as any).plans?.plans || {}) };
                    patches.planUpserts.forEach((p, id) => { plans[id] = p; });
                    (next as any).plans = { ...((next as any).plans || {}), plans };
                }
                if (patches.planStepUpdates.size > 0) {
                    const plans = { ...((next as any).plans?.plans || {}) };
                    patches.planStepUpdates.forEach(({ planId, stepId, patch }) => {
                        const plan = plans[planId];
                        if (plan) {
                            const steps = plan.steps.map((s: PlanStep) => s.id === stepId ? { ...s, ...patch } : s);
                            plans[planId] = { ...plan, steps };
                        }
                    });
                    (next as any).plans = { ...((next as any).plans || {}), plans };
                }
                if (patches.policyParamsReplace) (next as any).policyParams = patches.policyParamsReplace;
                if (patches.rewardParamsReplace) (next as any).rewardParams = patches.rewardParamsReplace;
                return next;
            },
            __drain: () => patches
        };
        return writer;
    };

    const flushMemoryPatches = async (patches: ReturnType<ReturnType<typeof createMemoryWriter>['__drain']>) => {
        const semantic = (ctx as any).memory?.semantic;
        const upsertCount = patches.semanticUpserts.size;
        const deleteCount = patches.semanticDeletes.size;
        const appendWriteEvents = async () => {
            try {
                const writeKeys = [...patches.semanticUpserts.keys()];
                if (writeKeys.length > 0) {
                    await appendOperatorMemoryEvent(ctx, {
                        op: 'write',
                        keys: writeKeys,
                        status: 'success',
                        backend: 'semantic',
                        turnSeq: env.turn,
                        agentId: ctx.agentId,
                        source: 'loop.memory',
                    });
                }
                const deleteKeys = [...patches.semanticDeletes.values()];
                if (deleteKeys.length > 0) {
                    await appendOperatorMemoryEvent(ctx, {
                        op: 'delete',
                        keys: deleteKeys,
                        status: 'success',
                        backend: 'semantic',
                        turnSeq: env.turn,
                        agentId: ctx.agentId,
                        source: 'loop.memory',
                    });
                }
            } catch (eventErr) {
                log.debug('Failed to append operator memory write/delete event', {
                    error: eventErr instanceof Error ? eventErr.message : String(eventErr),
                });
            }
        };
        if (!semantic || (upsertCount === 0 && deleteCount === 0)) {
            await appendWriteEvents();
            return;
        }

        const parentId = ctx.telemetry?.nodeId;
        const parentNode = parentId ? telemetry.getNode(parentId) : undefined;
        const traceId = parentNode?.traceId;
        let memNode: WorkflowNode | undefined;
        if (parentId) {
            memNode = new WorkflowNode('memory.semantic.flush', parentId, undefined, traceId);
            memNode.start({ upsertCount, deleteCount });
            telemetry.registerNode(memNode);
        }

        try {
            for (const [id, item] of patches.semanticUpserts.entries()) {
                await semantic.set?.(id, item.data ?? item, { tags: (item as any).tags, entities: (item as any).entities });
            }
            for (const id of patches.semanticDeletes.values()) {
                await semantic.delete?.(id);
            }
            if (memNode) {
                memNode.end({ ok: true, upsertCount, deleteCount }, 'success');
                telemetry.endNode(memNode);
            }
            await appendWriteEvents();
        } catch (err) {
            if (memNode) {
                const er = err instanceof Error ? err : new Error(String(err));
                memNode.fail(er);
                telemetry.failNode(memNode, er);
                telemetry.endNode(memNode);
            }
            log.warn('Failed to flush semantic patches', { error: err instanceof Error ? err.message : String(err) });
        }
        // Episodic/procedural/world/goals/policy/reward are persisted via MentalState snapshot
    };

    // Provide minimal defaults (prefer agent overrides when present)
    const defaults: Modules<Sensory, Obs, Alpha, ExecData, ExecError> = {
        attention: modules.attention ?? ((_prev, _env, _mem) => ({ kind: 'all' })),
        perception: modules.perception ?? ((e: EnvironmentState, _alpha: Alpha, _mem) => {
            const inboxState = ensureInbox(e);
            let turnInbox = Array.isArray(inboxState.current) ? [...inboxState.current] : [];

            // Perception validation for plans
            turnInbox = turnInbox.map(obs => {
                if (obs.source === 'internal' && (obs.kind === 'plan.proposed' || obs.kind === 'plan.updated')) {
                    try {
                        const validated = PlanSchema.parse(obs.payload);
                        return { ...obs, payload: validated };
                    } catch (err) {
                        log.warn('Dropped invalid plan observation', { kind: obs.kind, error: err });
                        return undefined;
                    }
                }
                return obs;
            }).filter((o): o is NonNullable<typeof o> => !!o);

            // Default perception returns inbox observations
            return { time: e.time, pending: e.pending, inbox: turnInbox } as any;
        }),
        learning: modules.learning ?? ((prev, _prevAction, obs, _mem, writer, _rPrev) => {
            const next = { ...(prev as any) } as MentalState<Sensory>;
            try {
                const episodic = Array.isArray((next as any).memory?.longTerm?.episodic)
                    ? [...(next as any).memory.longTerm.episodic]
                    : [];
                const event = { t: Date.now(), obs, act: undefined } as any;
                episodic.push(event);
                ((next as any).memory.longTerm as any).episodic = episodic;
                (writer as any).episodic?.append?.(event);

                const inboxArr = Array.isArray((obs as { inbox?: Observation[] }).inbox)
                    ? (obs as { inbox: Observation[] }).inbox
                    : [];
                (next as MentalState).memory = (next as MentalState).memory ?? ({} as MentalState['memory']);
                (next as MentalState).memory.conversation = reduceConversationProjection(
                    (next as MentalState).memory.conversation,
                    inboxArr
                );

                // Learning: Single Writer for M.plans
                const internal = (obs as any).internal?.();
                if (internal) {
                    const kind = internal.kind;
                    const payload = internal.payload;
                    if (kind === 'plan.proposed') {
                        (writer as any).plans?.set?.({
                            plans: { [payload.id]: payload },
                            activePlanId: payload.id
                        });
                    } else if (kind === 'plan.updated') {
                        (writer as any).plans?.add?.(payload);
                    } else if (kind === 'plan.step.updated') {
                        // payload would need to include planId and stepId and the patch
                        const { planId, stepId, ...patch } = payload;
                        (writer as any).plans?.updateStep?.(planId, stepId, patch);
                    }
                }
            } catch { /* noop */ }
            // Update lastObservation for ReAct patterns
            try {
                const input = (obs as any)?.input;
                const asString = typeof input === 'string' ? input : JSON.stringify(input);
                (next as any).memory = (next as any).memory || ({} as any);
                (next as any).memory.sensory = { ...((next as any).memory.sensory || {}), lastObservation: asString };
            } catch { /* noop */ }
            return next;
        }),
        policy: modules.policy ?? ((m: MentalState, _mem) => {
            const react = (m as any)?.policyParams?.reactPlanner;
            const sensory = ((m as any)?.memory?.sensory || {}) as any;
            const lastObs = (sensory?.lastObservation) ?? undefined;
            if (react?.enabled && typeof lastObs === 'string' && Array.isArray(react.patterns)) {
                for (const p of react.patterns) {
                    try {
                        const re = new RegExp(p.regex, 'i');
                        const match = lastObs.match(re);
                        if (match) {
                            const argVal = match[1] || match[0];
                            // Multi-step: if we have a prior tool result in scratch.react, use it to refine args
                            const scratch = (((m as any)?.memory as any)?.scratch?.react) || {};
                            const refinedArgs = { [p.argKey]: argVal, context: scratch.lastResult };
                            return { kind: 'call_tool', toolName: p.tool, args: refinedArgs } as any;
                        }
                    } catch { /* ignore bad regex */ }
                }
            }
            return { kind: 'answer_with_llm', query: 'Ok.' } as any;
        }),
        shield: modules.shield ?? ((m, a, _mem) => {
            try {
                const mWithHitl = m as MentalState & {
                    hitl?: string;
                    policyParams?: { hitl?: string };
                    safety?: { costLimit?: number; piiPatterns?: string[] };
                    lastAdvise?: unknown;
                };
                const level = iCtx.__manifestHitl?.level ?? mWithHitl.hitl ?? mWithHitl.policyParams?.hitl;
                const safety = mWithHitl.safety ?? {};
                if (!level) return { action: 'pass', intent: a };
                if (level === 'guardrails' && (a.kind === 'call_tool' || a.kind === 'delegate_to_child')) {
                    mWithHitl.lastAdvise = { kind: a.kind, policy: 'guardrails' };
                    return { action: 'defer', askUser: 'Approve action?' };
                }
                if (level === 'consent' && a.kind === 'call_tool') {
                    mWithHitl.lastAdvise = { kind: a.kind, tool: a.toolName, toolArgs: a.args, policy: 'consent' };
                    return { action: 'defer', askUser: `Run tool ${a.toolName}?` };
                }
                if (a.kind === 'call_tool') {
                    const cost = Number((isRecord(a.args) ? a.args.cost : 0) ?? 0);
                    if (Number.isFinite(cost) && typeof safety.costLimit === 'number' && cost > safety.costLimit) {
                        mWithHitl.lastAdvise = { blocked: 'cost', cost, limit: safety.costLimit };
                        return { action: 'defer', askUser: `Action cost ${cost} exceeds limit ${safety.costLimit}. Proceed?` };
                    }
                }
                const patterns = Array.isArray(safety.piiPatterns) ? safety.piiPatterns : [];
                if (patterns.length > 0 && a.kind === 'call_tool') {
                    const regexes = patterns.map((p) => new RegExp(p, 'i'));
                    const scanForPII = (value: unknown): boolean => {
                        if (typeof value === 'string') return regexes.some((r) => r.test(value));
                        if (Array.isArray(value)) return value.some(scanForPII);
                        if (isRecord(value)) return Object.values(value).some(scanForPII);
                        return false;
                    };
                    if (scanForPII(a.args)) {
                        mWithHitl.lastAdvise = { flagged: 'pii' };
                        return { action: 'defer', askUser: 'Action contains potential PII. Proceed?' };
                    }
                }
                if (level === 'advise') {
                    mWithHitl.lastAdvise = { kind: a.kind, policy: 'advise' };
                }
                return { action: 'pass', intent: a };
            } catch {
                return { action: 'pass', intent: a };
            }
        }),
        execution: modules.execution ?? (async (a: Intent, ctx: TaskContext, _mem) => {
            const base: ExecResult = { status: 'ok', ts: Date.now() };
            const internalCtx = ctx as InternalTaskContext & {
                flushSnapshot?: (state: { M: MentalState<Sensory>; env: EnvironmentState }) => Promise<void>;
            };

            if (a.kind === 'prompt_user') {
                const handle = await ctx.requestInput(a.prompt, {
                    schema: a.schema,
                    onProvided: '__onInputProvided'
                });
                const token = isRecord(handle) && typeof handle.token === 'string' ? handle.token : '';
                try { log.info('Execution asking for user input', { token }); } catch { /* noop */ }
                return {
                    action: { kind: 'prompt_user', token } as ExecutableAction,
                    result: {
                        ...base,
                        data: { prompt: a.prompt },
                        correlationId: token || undefined,
                        toolId: 'user'
                    }
                };
            }

            if (a.kind === 'delegate_to_child') {
                if (typeof internalCtx.flushSnapshot === 'function') {
                    try {
                        log.debug('LoopRunner: calling flushSnapshot before subagent', { toolId: a.agentId });
                        await internalCtx.flushSnapshot({ M, env });
                    } catch (e) {
                        log.warn('Failed to flush snapshot before subagent dispatch', { error: (e as Error).message });
                    }
                } else {
                    log.warn('LoopRunner: flushSnapshot not available on context for subagent dispatch');
                }

                const res = await ctx.sendTaskToAgent(a.agentId, a.input as TaskInput, {
                    onCompleted: '__onChildCompleted'
                });
                const token = isRecord(res)
                    ? (typeof res.token === 'string' ? res.token : undefined)
                    : undefined;
                if (token) {
                    return {
                        action: { kind: 'delegate_to_child', token } as ExecutableAction,
                        result: { ...base, correlationId: token, toolId: a.agentId }
                    };
                }
                return {
                    action: { kind: 'delegate_to_child' } as ExecutableAction,
                    result: { ...base, data: res, toolId: a.agentId }
                };
            }

            if (a.kind === 'call_tool') {
                const toolName = a.toolName;
                if (typeof internalCtx.flushSnapshot === 'function') {
                    try {
                        log.debug('LoopRunner: calling flushSnapshot before tool', { toolId: toolName });
                        await internalCtx.flushSnapshot({ M, env });
                    } catch (e) {
                        log.warn('Failed to flush snapshot before tool execution', { error: (e as Error).message });
                    }
                } else {
                    log.debug('LoopRunner: flushSnapshot not available on context for tool execution', { toolId: toolName });
                }

                if (a.mode === 'async') {
                    const handle = await ctx.requestTool(toolName, a.args, {
                        onCompleted: '__onToolCompleted'
                    });
                    const token = isRecord(handle) && typeof handle.token === 'string' ? handle.token : '';
                    return {
                        action: { kind: 'call_tool', token } as ExecutableAction,
                        result: { ...base, correlationId: token || undefined, toolId: toolName }
                    };
                }
                try {
                    const result = await ctx.tools.invoke(toolName, a.args);
                    return {
                        action: { kind: 'call_tool' } as ExecutableAction,
                        result: { ...base, data: result, toolId: toolName }
                    };
                } catch (error) {
                    return {
                        action: { kind: 'call_tool' } as ExecutableAction,
                        result: {
                            ...base,
                            status: 'error',
                            error: {
                                code: 'tool_invoke_error',
                                message: error instanceof Error ? error.message : String(error)
                            },
                            toolId: toolName
                        }
                    };
                }
            }

            if (a.kind === 'answer_with_llm') {
                const llmConfigured = internalCtx.__llmConfigured === true || typeof ctx.llm?.getHistoryMode === 'function';
                if (!llmConfigured) {
                    await ctx.reply(a.query);
                    return {
                        action: { kind: 'answer_with_llm', echoed: true } as ExecutableAction,
                        result: {
                            ...base,
                            status: 'error',
                            error: {
                                code: 'llm_not_configured',
                                message: 'No LLM configured; echoed query as fallback.'
                            },
                            data: { echoed: true, query: a.query, text: a.query },
                            toolId: 'language'
                        }
                    };
                }

                const responses = await ctx.llm.call(a.query);
                const text = typeof responses[0]?.content === 'string' ? responses[0].content : 'No LLM response.';
                await ctx.reply(text);
                return {
                    action: { kind: 'answer_with_llm', echoed: false } as ExecutableAction,
                    result: { ...base, data: { echoed: false, query: a.query, text }, toolId: 'language' }
                };
            }

            if (a.kind === 'create_plan') {
                return {
                    action: { kind: 'internal', done: false } as ExecutableAction,
                    result: {
                        ...base,
                        data: { planProposed: { id: `plan_${Date.now()}`, goalId: a.goalId, steps: [], status: 'proposed' } },
                        toolId: 'internal'
                    }
                };
            }

            if (a.kind === 'internal') {
                const maybeDone = a as unknown as Record<string, unknown>;
                const legacyDone = typeof maybeDone.done === 'boolean' ? maybeDone.done : false;
                return {
                    action: { kind: 'internal', done: legacyDone } as ExecutableAction,
                    result: { ...base, data: { intent: a.intent, done: legacyDone }, toolId: 'internal' }
                };
            }

            if (a.kind === 'complete') {
                return {
                    action: { kind: 'internal', done: true } as ExecutableAction,
                    result: { ...base, data: { intent: 'complete', done: true, result: a.result }, toolId: 'internal' }
                };
            }

            return {
                action: { kind: 'internal', done: false } as ExecutableAction,
                result: { ...base, data: { intent: a.kind, done: false }, toolId: 'internal' }
            };
        }),
        transition: modules.transition ?? ((env, exec: ExecOutcome<ExecData, ExecError>, _m, _mem) => {
            const { action, result } = exec;

            if (result.status === 'ok') {

                if (action.kind === 'prompt_user' && action.token) {
                    try { log.info('Transition to await_input', { token: action.token }); } catch { }
                    return { kind: 'await_input', token: action.token } as TransitionOut;
                }

                if (action.kind === 'delegate_to_child' && action.token) {
                    return { kind: 'await_child', token: action.token } as TransitionOut;
                }

                if (action.kind === 'call_tool' && action.token) {
                    return { kind: 'await_tool', token: action.token } as TransitionOut;
                }

                // ✅ FIX v3.5: Check if there are pending children even if action.kind !== 'subagent'
                // This handles cases where custom execution modules dispatch children but return { kind: 'internal' }
                const pendingChildren = env.pending?.children;
                if (pendingChildren && typeof pendingChildren === 'object') {
                    const tokens = Object.keys(pendingChildren);
                    if (tokens.length > 0) {
                        const firstToken = tokens[0];
                        try { log.info('Default transition: detected pending child, returning await_child', { token: firstToken?.substring(0, 15), totalPending: tokens.length }); } catch { }
                        return { kind: 'await_child', token: firstToken } as TransitionOut;
                    }
                }

                const pendingEvents = env.pending?.events;
                if (pendingEvents && typeof pendingEvents === 'object') {
                    const tokens = Object.keys(pendingEvents);
                    if (tokens.length > 0) {
                        const firstToken = tokens[0];
                        try { log.info('Default transition: detected pending external event, returning await_event', { token: firstToken?.substring(0, 15), totalPending: tokens.length }); } catch { }
                        return { kind: 'await_event', token: firstToken } as TransitionOut;
                    }
                }

                if (action.kind === 'internal' && action.done === true) {
                    return { kind: 'complete' } as TransitionOut;
                }

                // Planning transitions
                const data = result.data;
                const obs: Observation[] = [];
                if (result.toolId === 'language') {
                    const payload = LLMRespondedPayloadSchema.parse({
                        hasStructuredOutput: isRecord(data) ? data.echoed === false : false,
                        contentSummary: isRecord(data) && typeof data.text === 'string' ? data.text.slice(0, 240) : undefined,
                    });
                    obs.push({ source: 'internal', kind: 'llm.responded', payload });
                }
                if (isRecord(data) && 'planProposed' in data) {
                    obs.push({ source: 'internal', kind: 'plan.proposed', payload: data.planProposed });
                }
                if (isRecord(data) && 'planUpdated' in data) {
                    obs.push({ source: 'internal', kind: 'plan.updated', payload: data.planUpdated });
                }
                if (isRecord(data) && 'planStepUpdated' in data) {
                    obs.push({ source: 'internal', kind: 'plan.step.updated', payload: data.planStepUpdated });
                }

                if (obs.length === 0) {
                    obs.push({
                        source: 'internal',
                        kind: 'state.noted',
                        payload: {
                            intent: action.kind,
                            reason: 'continue_implicit'
                        }
                    });
                }

                return { kind: 'continue', observations: obs } as TransitionOut;

            }

            const errorCode = result.error?.code;
            if (errorCode === 'schema_mismatch' || errorCode === 'contract_failed' || errorCode === 'llm_not_configured') {
                const payload = ValidationFailedPayloadSchema.parse({
                    reason: errorCode === 'llm_not_configured' ? 'llm_not_configured' : 'llm_contract_failed',
                    error: result.error,
                });
                return { kind: 'continue', observations: [{ source: 'internal', kind: 'validation.failed', payload }] } as TransitionOut;
            }
            return { kind: 'continue', observations: [] as Observation[] } as TransitionOut;
        }),
        extrinsicReward: modules.extrinsicReward ?? ((m, _a, _exec, _out) => {
            try {
                const nodes = ((m as any)?.goalState?.hierarchy?.nodes) || {};
                const done = Object.values(nodes as any).filter((n: any) => n?.status === 'done').length;
                const prevDone = Number(((m as any).DoneCount) ?? 0);
                (m as any).DoneCount = done;
                return Math.max(0, done - prevDone);
            } catch { return 0; }
        }),
        intrinsicReward: modules.intrinsicReward ?? ((m, obs, _mem) => {
            try {
                // Opt-in only: if intrinsic.novelty is falsy, skip tracking entirely.
                const noveltyWeight = Number((m as any)?.rewardParams?.intrinsic?.novelty ?? 0);
                if (!noveltyWeight) return 0;

                const st = (m.memory as any);
                st.scratch = st.scratch || {};
                const scratch = st.scratch as any;
                scratch.__novelty = scratch.__novelty || [];
                const arr: string[] = scratch.__novelty as string[];

                // Hard-truncate the serialized observation to keep snapshot size small.
                const serialized = JSON.stringify(obs) ?? '';
                const maxLen = 512;
                const key = serialized.length > maxLen
                    ? `${serialized.slice(0, maxLen)}::len=${serialized.length}`
                    : serialized;

                const seen = new Set(arr);
                const isNew = !seen.has(key);
                if (isNew) {
                    arr.push(key);
                    // Keep the novelty ring buffer small to avoid snapshot bloat.
                    const maxEntries = 64;
                    if (arr.length > maxEntries) arr.splice(0, arr.length - maxEntries);
                    return 0.1 * noveltyWeight;
                }
                return 0;
            } catch { return 0; }
        })
    } as Modules<Sensory, Obs, Alpha, ExecData, ExecError>;

    function scanForPII(value: unknown, regexes: RegExp[]): boolean {
        try {
            if (value == null) return false;
            if (typeof value === 'string') return regexes.some(r => r.test(value));
            if (Array.isArray(value)) return value.some(v => scanForPII(v, regexes));
            if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(v => scanForPII(v, regexes));
            return false;
        } catch { return false; }
    }

    // Expose defaults on ctx so agent overrides can delegate
    (ctx as any).defaults = defaults;

    let m = M;
    let prevAction: Intent | undefined = undefined;
    let rPrev: number | undefined = undefined;
    let outcome: TurnOutcome = { kind: 'continue', observations: [] };
    const timings: Record<string, number>[] = [];
    const rewards: number[] = [];

    // env.turn is already set correctly by taskEngine for the first turn
    // 🔍 DEBUG: Log initial state
    log.debug('🔍 DEBUG: Loop starting', {
        taskId,
        runId,
        initialEnvTurn: (env as any).turn,
        maxTurns,
        loopWillRun: maxTurns > 0
    });

    const topicSweeperOpts = opts.topicSweeper;
    const tenantIdForSweep = typeof ctx.tenantId === 'string' && ctx.tenantId.length > 0 ? ctx.tenantId : undefined;
    type TopicSweeperEngineHandle = {
        triggerTopicLifecycleSweep?: (p: {
            tenantId: string;
            nowIso?: string;
            limit?: number;
            autoArchiveAfterMs?: number | null;
        }) => Promise<{ archivedTopicIds: string[] }>;
    };
    let topicSweeperEngine: TopicSweeperEngineHandle | null = null;
    /** `0` means "due immediately" on the first check between turns. */
    let nextTopicSweepDueAt = 0;
    if (
        topicSweeperOpts &&
        topicSweeperOpts.intervalMs > 0 &&
        topicSweeperOpts.autoArchiveAfterMs > 0 &&
        tenantIdForSweep
    ) {
        const eng = EngineLocator.getEngine<TopicSweeperEngineHandle>();
        if (eng?.triggerTopicLifecycleSweep) {
            topicSweeperEngine = eng;
            nextTopicSweepDueAt = 0;
        } else {
            log.debug('Topic sweeper schedule skipped: no TaskEngine with triggerTopicLifecycleSweep on EngineLocator', {
                taskId,
            });
        }
    }

    const runTopicSweeperIfDue = async (): Promise<void> => {
        if (!topicSweeperOpts || !tenantIdForSweep || !topicSweeperEngine?.triggerTopicLifecycleSweep) {
            return;
        }
        const now = Date.now();
        if (nextTopicSweepDueAt !== 0 && now < nextTopicSweepDueAt) {
            return;
        }
        try {
            await topicSweeperEngine.triggerTopicLifecycleSweep({
                tenantId: tenantIdForSweep,
                limit: topicSweeperOpts.batchSize,
                autoArchiveAfterMs: topicSweeperOpts.autoArchiveAfterMs,
            });
        } catch (e) {
            log.warn('Topic lifecycle sweep tick failed', {
                error: e instanceof Error ? e.message : String(e),
                tenantId: tenantIdForSweep,
            });
        }
        nextTopicSweepDueAt = Date.now() + topicSweeperOpts.intervalMs;
    };

    for (let turnIdx = 0; turnIdx < maxTurns; turnIdx++) {
        // ✅ FIX: Only increment turn if this is NOT the first iteration of this loop call.
        // The first turn count is now incremented by TaskExecutor before initialization.
        if (turnIdx > 0) {
            (env as any).turn = ((env as any).turn || 0) + 1;
        }

        // Current turn number for logging and state
        const turn = (env as any).turn;
        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log(`[runLoop] Iteration ${turnIdx}: env.turn=${(env as any).turn}, turn scope variable=${turn}`);
        }

        await runTopicSweeperIfDue();

        // Update logging context with current turn number
        updateLoggingContext({ turn });

        // 🔍 DEBUG: Log each iteration
        if (opts.latencyMs != null && Date.now() - start > opts.latencyMs) {
            const elapsed = Date.now() - start;
            throwInvariantError(
                'BUDGET_LATENCY_EXCEEDED',
                `Latency budget exceeded: limit ${opts.latencyMs}ms, elapsed ${elapsed}ms`,
                { type: 'budget_exceeded', budget: 'latency', limit: opts.latencyMs, actual: elapsed }
            );
        }

        // Create explicit TurnNode for this iteration
        // This ensures tracking of individual turns even within a multi-turn runLoop
        let iterationTurnNode: TurnNode | undefined;
        let prevCtxTurnNodeId: string | undefined;
        let prevCtxTelemetryNodeId: string | undefined;

        try {
            log.debug('Before oneTurn', { taskId, runId, turn: turnIdx });

            // ✅ FIX: Validate that ctx.memory exists before calling oneTurn
            if (!(ctx as any).memory) {
                log.warn('ctx.memory is undefined - this may cause errors if agent uses memory operations', {
                    taskId,
                    runId,
                    turn: turnIdx,
                    agentId: (ctx as any).agentId
                });
            }

            // --- TELEMETRY START ---
            try {
                // Capture previous state for restoration
                prevCtxTurnNodeId = (ctx as any).currentTurnNodeId;
                prevCtxTelemetryNodeId = ctx.telemetry?.nodeId;

                const OuterTurnNodeId = (ctx as any).currentTurnNodeId; // ID from TurnRunner (execution session)
                const turnIndex = turn;
                // If there's no outer ID, we might be root or detached.
                // We create a new TurnNode child of whatever is current in ctx.telemetry?
                // Or child of OuterTurnNodeId if available.
                // If OuterTurnNodeId is set, it means TurnRunner already made a node.
                // If we also make a node, we get nested turns: Execution -> Turn X. This is desired.

                const parentId = OuterTurnNodeId || ctx.telemetry?.nodeId;
                const parentNode = parentId ? telemetry.getNode(parentId) : undefined;
                const traceId =
                    parentNode?.traceId ?? resolveTraceIdForTurnParent(parentId, ctx);
                iterationTurnNode = new TurnNode(turnIndex, parentId, undefined, traceId);

                // Track input for this specific turn (the inbox contents)
                iterationTurnNode.start({
                    turnIndex,
                    inbox: env.inbox.current
                });
                telemetry.registerNode(iterationTurnNode);

                // Update context so modules attach to THIS turn

                (ctx as any).currentTurnNodeId = iterationTurnNode.id;
                if (ctx.telemetry) {
                    ctx.telemetry.nodeId = iterationTurnNode.id;
                }

                // Initialize turn accumulators so bridge/orchestration can push LLM/tool/child summaries
                const iCtxTurn = ctx as InternalTaskContext;
                iCtxTurn.__turnLlmCalls = [];
                iCtxTurn.__turnToolCalls = [];
                iCtxTurn.__turnChildCalls = [];
                iCtxTurn.__turnIncomingConversationMessages = [];
                iCtxTurn.__turnOutgoingConversationMessages = [];
                iCtxTurn.__turnConversationSummary = undefined;
                iCtxTurn.__turnConversationSequenceNumber = undefined;
                iCtxTurn.__turnConversationDedupeHit = undefined;
                iCtxTurn.__turnConversationDeliveryLagMs = undefined;
                iCtxTurn.__turnTopicSelectorDecision = undefined;
                iCtxTurn.__turnFanoutSummary = undefined;
                iCtxTurn.__turnStopPolicy = undefined;
                iCtxTurn.__turnBackpressure = undefined;
                iCtxTurn.__turnInviteAutoJoin = {};
                iCtxTurn.__operatorMemoryEvent = (event) =>
                    appendOperatorMemoryEvent(ctx, {
                        ...event,
                        turnSeq: event.turnSeq ?? env.turn,
                        agentId: event.agentId ?? ctx.agentId,
                    });

                await appendOperatorTurnStartedEvent(
                    ctx,
                    turnIndex,
                    iterationTurnNode.id,
                    traceId,
                    iterationTurnNode.id
                );
            } catch (err) {
                log.warn('Failed to start iteration TurnNode', { error: err });
            }
            // -----------------------

            if (opts.autoJoinInvitedTopics === true) {
                await runDefaultAutoJoinInvitedTopics({ ctx, env, iCtx });
            }

            const memReader = createMemoryReader(m);
            const writer = createMemoryWriter();

            let step;
            try {
                step = await oneTurn<Sensory, Obs, Alpha, ExecData, ExecError>(
                    ctx,
                    env,
                    m,
                    defaults,
                    memReader,
                    writer,
                    prevAction,
                    rPrev
                );
            } catch (turnError) {
                const errorMessage = turnError instanceof Error ? turnError.message : String(turnError);
                const errorStack = turnError instanceof Error ? turnError.stack : undefined;
                log.error('Turn execution failed', {
                    taskId,
                    runId,
                    turn: turnIdx,
                    error: errorMessage,
                    stack: errorStack,
                    hasMemory: !!(ctx as any).memory,
                    memoryType: typeof (ctx as any).memory,
                    agentId: (ctx as any).agentId
                });

                if (iterationTurnNode) {
                    iterationTurnNode.fail(turnError instanceof Error ? turnError : new Error(errorMessage));
                    telemetry.failNode(iterationTurnNode, turnError instanceof Error ? turnError : new Error(errorMessage));
                }

                throw turnError;
            }
            m = step.m;

            // Flush writer patches to adapters (semantic) and rely on snapshot for the rest
            try {
                const patches = (writer as any).__drain?.();
                if (patches) {
                    await flushMemoryPatches(patches);
                }
            } catch (flushErr) {
                log.warn('Failed to flush memory patches', { error: flushErr instanceof Error ? flushErr.message : String(flushErr) });
            }

            outcome = step.outcome;

            const consumedConversationMessageKeys: ReadonlySet<string> = new Set(
                (iCtx.__turnIncomingConversationMessages ?? []).map((msg) =>
                    conversationInboxDeliveryKeyFromTurnSummary(msg)
                )
            );
            if (consumedConversationMessageKeys.size > 0) {
                const accumulated =
                    iCtx.__conversationConsumedDeliveryKeys ?? new Set<string>();
                for (const key of consumedConversationMessageKeys) {
                    accumulated.add(key);
                }
                iCtx.__conversationConsumedDeliveryKeys = accumulated;
            }

            const totalMs =
                (step.timings?.attentionMs ?? 0) +
                (step.timings?.perceptionMs ?? 0) +
                (step.timings?.learningMs ?? 0) +
                (step.timings?.policyMs ?? 0) +
                (step.timings?.shieldMs ?? 0) +
                (step.timings?.executionMs ?? 0) +
                (step.timings?.transitionMs ?? 0);
            const turnTimings: TurnTimings = {
                attentionMs: step.timings?.attentionMs ?? 0,
                perceptionMs: step.timings?.perceptionMs ?? 0,
                learningMs: step.timings?.learningMs ?? 0,
                policyMs: step.timings?.policyMs ?? 0,
                shieldMs: step.timings?.shieldMs ?? 0,
                executionMs: step.timings?.executionMs ?? 0,
                transitionMs: step.timings?.transitionMs ?? 0,
                totalMs,
            };
            const stageBefore = step.stageTrace?.stageBefore ?? 'idle';
            const stageAfter = step.stageTrace?.stageAfter ?? stageBefore;
            const turnId = iterationTurnNode?.id ?? uuidv7();
            const correlationId = generateCorrelationId();
            const parentNode =
                iterationTurnNode?.parentId != null && iterationTurnNode.parentId !== ''
                    ? telemetry.getNode(iterationTurnNode.parentId)
                    : undefined;
            const traceId =
                iterationTurnNode?.traceId ??
                parentNode?.traceId ??
                resolveTraceIdForTurnParent(iterationTurnNode?.parentId, ctx);
            const spanId = iterationTurnNode?.id ?? undefined;

            const usage = usageFromTurnCalls(iCtx);

            const inviteIssued: Array<{
                token: string;
                topicId: string;
                inviteeAgentId: string;
                expiresAt: string;
            }> = [];
            const inviteReceived: Array<{
                token: string;
                topicId: string;
                inviterAgentId: string;
                expiresAt: string;
                autoJoinAttempted: boolean;
                autoJoinError?: {
                    type:
                        | 'InviteNotFound'
                        | 'InviteExpired'
                        | 'InviteAlreadyConsumed'
                        | 'InviteTargetMismatch';
                    message: string;
                };
            }> = [];
            const inviteAccepted: Array<{
                token: string;
                topicId: string;
                memberId: string;
                agentId: string;
            }> = [];
            const inviteDeclined: Array<{
                token: string;
                topicId: string;
                inviteeAgentId: string;
                reason?: string;
            }> = [];
            const inviteExpired: Array<{
                token: string;
                topicId: string;
                inviteeAgentId: string;
                expiresAt: string;
            }> = [];
            for (const obs of env.inbox.current) {
                if (obs.source !== 'conversation') continue;
                const payload = (obs as { payload?: Record<string, unknown> }).payload;
                const kind = asString(payload?.kind);
                if (!kind) continue;
                if (kind === 'topic.invite.issued') {
                    const topic = payload?.topic as Record<string, unknown> | undefined;
                    const invitee = payload?.invitee as Record<string, unknown> | undefined;
                    const token = asString(payload?.token);
                    const topicId = asString(topic?.id);
                    const inviteeAgentId = asString(invitee?.agentId);
                    const expiresAt = asString(payload?.expiresAt);
                    if (token && topicId && inviteeAgentId && expiresAt) {
                        inviteIssued.push({ token, topicId, inviteeAgentId, expiresAt });
                    }
                } else if (kind === 'topic.invite.received') {
                    const topic = payload?.topic as Record<string, unknown> | undefined;
                    const token = asString(payload?.token);
                    const topicId = asString(topic?.id);
                    const inviterAgentId = asString(payload?.inviterAgentId);
                    const expiresAt = asString(payload?.expiresAt);
                    if (token && topicId && inviterAgentId && expiresAt) {
                        const autoJoin = iCtx.__turnInviteAutoJoin?.[token];
                        inviteReceived.push({
                            token,
                            topicId,
                            inviterAgentId,
                            expiresAt,
                            autoJoinAttempted: autoJoin?.attempted === true,
                            autoJoinError: autoJoin?.error,
                        });
                    }
                } else if (kind === 'topic.invite.accepted') {
                    const topic = payload?.topic as Record<string, unknown> | undefined;
                    const member = payload?.member as Record<string, unknown> | undefined;
                    const token = asString(payload?.token);
                    const topicId = asString(topic?.id);
                    const memberId = asString(member?.memberId);
                    const agentId = asString(member?.agentId);
                    if (token && topicId && memberId && agentId) {
                        inviteAccepted.push({ token, topicId, memberId, agentId });
                    }
                } else if (kind === 'topic.invite.declined') {
                    const topic = payload?.topic as Record<string, unknown> | undefined;
                    const token = asString(payload?.token);
                    const topicId = asString(topic?.id);
                    const inviteeAgentId = asString(payload?.inviteeAgentId);
                    const reason = asString(payload?.reason);
                    if (token && topicId && inviteeAgentId) {
                        inviteDeclined.push({ token, topicId, inviteeAgentId, reason });
                    }
                } else if (kind === 'topic.invite.expired') {
                    const topic = payload?.topic as Record<string, unknown> | undefined;
                    const token = asString(payload?.token);
                    const topicId = asString(topic?.id);
                    const inviteeAgentId = asString(payload?.inviteeAgentId);
                    const expiresAt = asString(payload?.expiresAt);
                    if (token && topicId && inviteeAgentId && expiresAt) {
                        inviteExpired.push({ token, topicId, inviteeAgentId, expiresAt });
                    }
                }
            }
            const inviteDelivery =
                inviteIssued.length > 0 ||
                inviteReceived.length > 0 ||
                inviteAccepted.length > 0 ||
                inviteDeclined.length > 0 ||
                inviteExpired.length > 0
                    ? {
                          issued: inviteIssued.length > 0 ? inviteIssued : undefined,
                          received: inviteReceived.length > 0 ? inviteReceived : undefined,
                          accepted: inviteAccepted.length > 0 ? inviteAccepted : undefined,
                          declined: inviteDeclined.length > 0 ? inviteDeclined : undefined,
                          expired: inviteExpired.length > 0 ? inviteExpired : undefined,
                      }
                    : undefined;

            const tracePayload: TurnTrace = {
                turn,
                turnId,
                agentCardSource: provenance.agentCardSource,
                runtimeManifestSource: provenance.runtimeManifestSource,
                agentCardHash: provenance.agentCardHash,
                runtimeManifestHash: provenance.runtimeManifestHash,
                stageBefore,
                stageAfter,
                stageTransition:
                    stageAfter !== stageBefore
                        ? { from: stageBefore, to: stageAfter }
                        : undefined,
                stageAutoMarksApplied: step.stageTrace?.stageAutoMarksApplied,
                stageInvariantChecks: step.stageTrace?.stageInvariantChecks,
                stageInvariantError: undefined,
                inboxCurrent: step.inboxSnapshot ?? [],
                attention: step.attention,
                perception: step.perception,
                mentalStateBeforeHash: step.mentalStateBeforeHash,
                mentalStateAfterHash: step.mentalStateAfterHash,
                intent: step.intent,
                shield: step.shield,
                manifestConsent: step.manifestConsent,
                execAction: step.exec?.action
                    ? {
                          kind: step.exec.action.kind,
                          token:
                              'token' in step.exec.action
                                  ? step.exec.action.token
                                  : undefined,
                          summary: undefined,
                          data: compactModuleOutput(step.exec.action),
                      }
                    : undefined,
                execResult: step.exec?.result
                    ? {
                          status: step.exec.result.status,
                          summary: undefined,
                          data: compactModuleOutput(step.exec.result.data),
                          error: compactModuleOutput(step.exec.result.error),
                          correlationId: step.exec.result.correlationId,
                      }
                    : undefined,
                transition: {
                    kind: outcome.kind,
                    token: 'token' in outcome ? outcome.token : undefined,
                    summary: undefined,
                    result: 'result' in outcome ? compactModuleOutput((outcome as { result?: unknown }).result) : undefined,
                },
                pendingAfter: summarizePending(env.pending ?? {}),
                timings: turnTimings,
                usage,
                rewards: step.reward !== undefined ? { total: step.reward } : undefined,
                correlationId,
                traceId,
                spanId,
                parentSpanId: iterationTurnNode?.parentId,
                llmCalls: iCtx.__turnLlmCalls,
                toolCalls: iCtx.__turnToolCalls,
                childCalls: iCtx.__turnChildCalls,
                conversation: iCtx.__turnConversationSummary,
                incomingMessages: iCtx.__turnIncomingConversationMessages,
                outgoingMessages: iCtx.__turnOutgoingConversationMessages,
                messageSequenceNumber: iCtx.__turnConversationSequenceNumber,
                dedupeHit: iCtx.__turnConversationDedupeHit,
                deliveryLagMs: iCtx.__turnConversationDeliveryLagMs,
                topicSelectorDecision: iCtx.__turnTopicSelectorDecision,
                fanoutSummary: iCtx.__turnFanoutSummary,
                stopPolicy: iCtx.__turnStopPolicy,
                inviteDelivery,
                backpressure: iCtx.__turnBackpressure,
            };

            let trace: TurnTrace;
            try {
                trace = TurnTraceSchema.parse(tracePayload) as TurnTrace;
            } catch (parseErr) {
                log.warn('TurnTrace parse failed, using payload', {
                    error: parseErr instanceof Error ? parseErr.message : String(parseErr),
                });
                trace = tracePayload;
            }

            if (iterationTurnNode) {
                iterationTurnNode.turnTrace = trace;
            }
            try {
                telemetry.emitTurnTrace(trace);
            } catch (emitErr) {
                log.warn('TurnTrace emission failed', {
                    error: emitErr instanceof Error ? emitErr.message : String(emitErr),
                });
            }
            try {
                await appendOperatorTurnEvent(ctx, trace);
            } catch (eventErr) {
                log.debug('Failed to append operator turn.completed event', {
                    error: eventErr instanceof Error ? eventErr.message : String(eventErr),
                });
            }
            if (collector) {
                collector.push(trace);
            }
            if (iCtx.__turnUsage) {
                iCtx.__turnUsage = undefined;
            }
            iCtx.__turnLlmCalls = undefined;
            iCtx.__turnToolCalls = undefined;
            iCtx.__turnChildCalls = undefined;
            iCtx.__turnIncomingConversationMessages = undefined;
            iCtx.__turnOutgoingConversationMessages = undefined;
            iCtx.__turnConversationSummary = undefined;
            iCtx.__turnConversationSequenceNumber = undefined;
            iCtx.__turnConversationDedupeHit = undefined;
            iCtx.__turnConversationDeliveryLagMs = undefined;
            iCtx.__turnTopicSelectorDecision = undefined;
            iCtx.__turnFanoutSummary = undefined;
            iCtx.__turnStopPolicy = undefined;
            iCtx.__turnBackpressure = undefined;
            iCtx.__turnInviteAutoJoin = undefined;
            iCtx.__operatorMemoryEvent = undefined;

            log.debug('Transition outcome', {
                taskId,
                runId,
                loopCounter: turnIdx,
                envTurn: turn,
                outcomeKind: outcome.kind,
                hasToken: !!(outcome as { token?: string }).token,
                actionKind: step.exec?.action?.kind,
                execStatus: step.exec?.result?.status,
            });

            if (iterationTurnNode) {
                iterationTurnNode.end({ outcome });
                telemetry.endNode(iterationTurnNode);
            }

            if (outcome.kind === 'continue' && !Array.isArray((outcome as any).observations)) {
                outcome = { kind: 'continue', observations: [] } as TransitionOut;
            }
            const observations = Array.isArray((outcome as any).observations)
                ? ((outcome as any).observations as Observation[])
                : [];

            if (outcome.kind === 'continue' && observations.length === 0) {
                throwInvariantError(
                    'CONTINUE_WITHOUT_OBSERVATIONS',
                    'Continue outcome requires at least one observation',
                    { type: 'transition_invariant', transitionKind: 'continue', reason: 'empty_observations', pendingSnapshot: env.pending }
                );
            }

            if (observations.length > 0) {
                const duplicateFiltered = observations.filter((obs) => {
                    const k = conversationInboxDeliveryKey(obs);
                    if (k === undefined) {
                        return true;
                    }
                    if (consumedConversationMessageKeys.has(k)) {
                        return false;
                    }
                    return true;
                });
                let nextCurrent = duplicateFiltered;
                if (
                    outcome.kind === 'continue' &&
                    nextCurrent.length === 0 &&
                    observations.length > 0
                ) {
                    nextCurrent = [
                        {
                            source: 'internal',
                            kind: 'state.noted',
                            payload: { reason: 'conversation_reemit_suppressed' },
                        } as Observation,
                    ];
                }
                if (nextCurrent.length > 0) {
                    inbox.all.push(...nextCurrent);
                    inbox.current = [...nextCurrent];
                } else {
                    env.inbox.current = [];
                }
            } else {
                // Hygiene: avoid having "phantom" observations by mistake
                // if next turn starts without them being cleared.
                // Perception is responsible for filling them.
                env.inbox.current = [];
            }

            if (consumedConversationMessageKeys.size > 0 && opts.onTurnCheckpoint) {
                await opts.onTurnCheckpoint({
                    M: m,
                    env,
                    outcome,
                    consumedConversationMessageKeys,
                });
            }

            timings.push(step.timings || {});
            rewards.push(step.reward || 0);

            // Update control snapshot for downstream modules
            try {
                (env as any).control = {
                    pendingSnapshot: env.pending,
                    lastExec: step.exec
                };
            } catch { /* noop */ }
        } catch (error) {
            if (error instanceof InvariantError || hasTaskTurnOwnershipLossCause(error)) throw error;
            console.error(`[LoopRunner] 🛑 FATAL: Turn ${turn} failed with exception!`, error);
            log.error(`Turn ${turn} failed`, { error: error instanceof Error ? error.message : String(error) });
            outcome = {
                kind: 'fail',
                reason: `turn_${turnIdx}_error: ${error instanceof Error ? error.message : String(error)}`,
                error: error
            };
            // Hygiene: clear current inbox on fatal error to avoid leaking state to next run
            env.inbox.current = [];
            if (iterationTurnNode) {
                try {
                    iterationTurnNode.fail(error instanceof Error ? error : new Error(String(error)));
                    telemetry.failNode(iterationTurnNode, error instanceof Error ? error : new Error(String(error)));
                } catch { }
            }
            break;
        } finally {
            // restore context (never use '' — it breaks LLM bridge parent resolution)
            if (ctx.telemetry && prevCtxTelemetryNodeId !== undefined) {
                ctx.telemetry.nodeId = prevCtxTelemetryNodeId;
            }
            (ctx as any).currentTurnNodeId = prevCtxTurnNodeId;
        }


        // Stop on await_* or terminal (do not log every iteration — Jest captures console output and long suites can OOM)
        if (outcome.kind !== 'continue') {
            // ✅ RADICAL FIX: If await_child but child result is ALREADY in inbox, continue instead of exiting!
            // This prevents the race condition where:
            // 1. Turn dispatches child with await_child
            // 2. Child completes synchronously (from cache)
            // 3. handleChildCompleted stages observation in inbox (in database)
            // 4. Loop would normally exit on await_child
            // 5. startTask saves await_child state
            // 6. Self-correction calls handleChildCompleted AGAIN (race!)
            // By continuing the loop, we process the child result in the SAME loop, avoiding the race.
            if (outcome.kind === 'await_child' && (outcome as any).token) {
                const awaitToken = (outcome as any).token;

                // First check local inbox OR the current env.inbox (which might be fresh/replaced)
                let childResultInInbox = inbox.all.some(
                    (o: any) => (o.kind === 'child.completed' || o.kind === 'child.failed') && o.payload?.token === awaitToken
                ) || env.inbox.all.some(
                    (o: any) => (o.kind === 'child.completed' || o.kind === 'child.failed') && o.payload?.token === awaitToken
                );

                // If not in local inbox, reload from database
                // (handleChildCompleted may have staged it during execution)
                if (!childResultInInbox) {
                    try {
                        const sessionManager = (ctx as any)._sessionManager;
                        const tenantId = (ctx as any).tenantId || 'default';
                        if (sessionManager && taskId) {
                            const freshSnap = await sessionManager.load(tenantId, taskId);
                            if (freshSnap) {
                                const freshInbox = (freshSnap.snapshot as any)?.inbox;
                                if (freshInbox && Array.isArray(freshInbox.all)) {
                                    childResultInInbox = freshInbox.all.some(
                                        (o: any) => (o.kind === 'child.completed' || o.kind === 'child.failed') && o.payload?.token === awaitToken
                                    );
                                    if (childResultInInbox) {
                                        log.debug('🔄 SYNC CHILD: Found child result in database inbox, continuing loop instead of yielding', {
                                            taskId,
                                            awaitToken: awaitToken?.substring(0, 15)
                                        });
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        log.debug('Failed to reload inbox from database', { error: (e as Error).message });
                    }
                }

                if (childResultInInbox) {
                    log.info('🔄 SYNC CHILD: Child result already in inbox, continuing loop instead of awaiting', {
                        taskId,
                        runId,
                        loopCounter: turnIdx,
                        envTurn: turn,
                        awaitToken: awaitToken?.substring(0, 15)
                    });
                    // Move child completion to current inbox for next turn
                    const childObs = inbox.all.find(
                        (o: any) => (o.kind === 'child.completed' || o.kind === 'child.failed') && o.payload?.token === awaitToken
                    ) || env.inbox.all.find(
                        (o: any) => (o.kind === 'child.completed' || o.kind === 'child.failed') && o.payload?.token === awaitToken
                    );
                    if (childObs) {
                        // ✅ FIX: Explicitly set inbox.current to ensure perception sees the result
                        // and it doesn't "blink" out due to turn reset
                        inbox.current = [childObs];

                        // ✅ FIX: Sync completion must update LLM history so it doesn't re-invoke
                        if ((ctx as any).llm?.addToolResult) {
                            const payload = childObs.payload as any;
                            const childAgentId = payload.agentId || (outcome as any).agentId;
                            try {
                                const toolResult = payload.result !== undefined ? (typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result)) : '{}';
                                (ctx as any).llm.addToolResult(awaitToken, toolResult, childAgentId);
                                log.debug('🔄 SYNC CHILD: Injected result into LLM history', { awaitToken: awaitToken?.substring(0, 15) });
                            } catch (e) {
                                log.debug('Failed to sync child result to LLM history', { error: (e as Error).message });
                            }
                        }
                    }

                    // ✅ FIX: Remove from pending children so next turn doesn't await again
                    if (env.pending && env.pending.children && awaitToken) {
                        delete env.pending.children[awaitToken];
                        log.debug('🔄 SYNC CHILD: Removed child from pending', { awaitToken: awaitToken?.substring(0, 15) });
                    }

                    // Convert await_child to continue so loop proceeds
                    outcome = { kind: 'continue', observations: [] } as TransitionOut;
                    // Don't break - continue to next turn
                    continue;
                }
            }

            // ✅ FIX: Same pattern for await_tool — if tool result was already injected
            // into inbox by handleToolCompleted (running concurrently in background),
            // continue the loop instead of exiting.
            if (outcome.kind === 'await_tool' && (outcome as any).token) {
                const awaitToken = (outcome as any).token;

                // Check if tool result is already in the inbox
                const toolResultInInbox = inbox.all.some(
                    (o: any) => o.kind === 'tool.completed' && o.payload?.token === awaitToken
                ) || env.inbox.all.some(
                    (o: any) => o.kind === 'tool.completed' && o.payload?.token === awaitToken
                );

                if (toolResultInInbox) {
                    log.info('🔄 SYNC TOOL: Tool result already in inbox, continuing loop instead of awaiting', {
                        taskId,
                        runId,
                        loopCounter: turnIdx,
                        envTurn: turn,
                        awaitToken: awaitToken?.substring(0, 15)
                    });
                    // Move tool completion to current inbox for next turn
                    const toolObs = inbox.all.find(
                        (o: any) => o.kind === 'tool.completed' && o.payload?.token === awaitToken
                    ) || env.inbox.all.find(
                        (o: any) => o.kind === 'tool.completed' && o.payload?.token === awaitToken
                    );
                    if (toolObs) {
                        // ✅ FIX: Explicitly set inbox.current
                        inbox.current = [toolObs];

                        // ✅ FIX: Sync tool completion must update LLM history
                        if ((ctx as any).llm?.addToolResult) {
                            const payload = toolObs.payload as any;
                            try {
                                const toolResult = payload.result !== undefined ? (typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result)) : '{}';
                                (ctx as any).llm.addToolResult(awaitToken, toolResult);
                                log.debug('🔄 SYNC TOOL: Injected result into LLM history', { awaitToken: awaitToken?.substring(0, 15) });
                            } catch (e) {
                                log.debug('Failed to sync tool result to LLM history', { error: (e as Error).message });
                            }
                        }
                    }

                    // Remove from pending tools
                    if (env.pending && (env.pending as any).tools && awaitToken) {
                        delete (env.pending as any).tools[awaitToken];
                    }

                    // Convert await_tool to continue so loop proceeds
                    outcome = { kind: 'continue', observations: [] } as TransitionOut;
                }
            }

            // Transition invariant enforcement: await_* must have token; terminal must have no pending
            if (outcome.kind !== 'continue') {
                if (outcome.kind === 'await_input' || outcome.kind === 'await_tool' || outcome.kind === 'await_child' || outcome.kind === 'await_event') {
                    const token = (outcome as { token?: string }).token;
                    if (typeof token !== 'string' || token.trim() === '') {
                        throwInvariantError(
                            'AWAIT_MISSING_TOKEN',
                            `Transition ${outcome.kind} requires a non-empty token`,
                            { type: 'transition_invariant', transitionKind: outcome.kind, reason: 'missing_token', pendingSnapshot: env.pending }
                        );
                    }
                }
                if (outcome.kind === 'complete' || outcome.kind === 'fail') {
                    const p = env.pending;
                    const hasPending =
                        (p?.inputs && Object.keys(p.inputs).length > 0) ||
                        (p?.children && Object.keys(p.children).length > 0) ||
                        (p?.tools && Object.keys(p.tools).length > 0) ||
                        (p?.events && Object.keys(p.events).length > 0) ||
                        (p?.groups && Object.keys(p.groups).length > 0);
                    if (hasPending) {
                        throwInvariantError(
                            'TERMINAL_WITH_PENDING',
                            'Terminal outcome (complete/fail) not allowed while pending inputs, tools, or children exist',
                            { type: 'transition_invariant', transitionKind: outcome.kind, reason: 'pending_await_exists', pendingSnapshot: p }
                        );
                    }
                }
            }

            // If AFTER sync checks outcome is STILL not continue, we stop.
            if (outcome.kind !== 'continue') {
                log.debug('🔍 DEBUG: Loop stopping (non-continue outcome)', {
                    taskId,
                    runId,
                    loopCounter: turnIdx,
                    envTurn: turn,
                    outcomeKind: outcome.kind,
                    hasToken: !!(outcome as any).token
                });
                break;
            }
        }

        // --- BUDGET CHECK FOR NEXT TURN ---
        const globalMaxTurns = (env as any).budget?.maxTurns;
        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log(`[runLoop] Budget check: turn=${turn}, globalMaxTurns=${globalMaxTurns}, typeof=${typeof globalMaxTurns}`);
        }
        if (typeof globalMaxTurns === 'number' && turn >= globalMaxTurns) {
            log.debug('🔍 DEBUG: Global budget check triggered', { taskId, runId, turn, globalMaxTurns });
            if (process.env.DEBUG_BACKGROUND_TASKS) {
                console.log(`[runLoop] budget_turns_exceeded hit! breaking loop`);
            }
            outcome = { kind: 'fail', reason: 'budget_turns_exceeded' };
            break;
        }

        if (turnIdx === maxTurns - 1) {
            log.debug('🔍 DEBUG: Local budget check triggered', { taskId, runId, turnIdx, maxTurns });
            throwInvariantError(
                'BUDGET_TURNS_EXCEEDED',
                `Loop budget exceeded: maximum of ${maxTurns} turns reached`,
                { type: 'budget_exceeded', budget: 'turns', limit: maxTurns, actual: turnIdx + 1 }
            );
        }

    }

    return {
        M: m,
        outcome,
        metrics: timings.length ? { timings, rewards } : undefined,
        ...(collectTraces && collector ? { traces: [...collector.getAll()] } : {}),
    };
}
