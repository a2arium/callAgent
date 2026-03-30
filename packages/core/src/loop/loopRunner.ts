import type { TaskContext } from '../shared/types/index.js';
import {
    oneTurn,
    type Modules,
    type TurnOutcome,
    type TransitionOut,
    type ExecResult,
    type ExecErrorPayload,
    type AttentionSignal,
    type Observation
} from './oneTurn.js';
import type { Intent, ExecutableAction } from '../types/intent.js';
import { normalizeObservationInbox, type EnvironmentState, type MentalState, type ObservationInbox } from './types.js';
import { logger, updateLoggingContext } from '@a2arium/callagent-utils';
import { TurnNode } from '../telemetry/nodes/TurnNode.js';
import { WorkflowNode } from '../telemetry/nodes/WorkflowNode.js';
import { telemetry } from '../telemetry/TelemetryCollector.js';
import { turnOpikDiagEnabled } from '../telemetry/turnOpikDiagEnv.js';
import { Plan, PlanState, PlanStep, PlanId, PlanSchema } from '../types/plan.js';
import { throwInvariantError } from '../utils/invariantError.js';
import { InvariantError } from '../utils/errors.js';
import type { InternalTaskContext } from './internalContext.js';
import type { TurnTrace, ManifestProvenance, TurnTimings } from '../types/turnTrace.js';
import { TurnTraceSchema } from '../types/turnTrace.js';
import { summarizePending, aggregateUsage, compactModuleOutput } from '../telemetry/turnTraceHelpers.js';
import { generateCorrelationId } from '../tracing/Tracing.js';
import { v7 as uuidv7 } from 'uuid';
import { TurnTraceCollector } from '../telemetry/TurnTraceCollector.js';

const log = logger.createLogger({ prefix: 'runLoop' });

/** Walk telemetry parents and ctx so TurnNode always gets the session trace id (Opik drops turns with undefined traceId). */
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
    try { log.info('LoopRunner started', { maxTurns }); } catch { }
    console.log(`[LoopRunner] STARTED. MaxTurns: ${maxTurns}, LatencyMs: ${opts.latencyMs}, TaskId: ${taskId}`);

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
                        return Array.isArray(res) ? res.map(normalizeSemantic) : [];
                    }
                    const concepts = (mState as any)?.memory?.longTerm?.semantic?.concepts || [];
                    if (!q || (!q.id && !q.tag && !q.tags)) return concepts;
                    const ids = q.id ? (Array.isArray(q.id) ? q.id : [q.id]) : undefined;
                    return concepts.filter((c: any) => (!ids || ids.includes(c.id)));
                },
                get: async (id) => {
                    const res = await (semanticRegistry?.read ? semanticRegistry.read(id) : undefined);
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
                        const nodes = Object.fromEntries(Object.entries(current.nodes).filter(([_, v]) => predicate ? predicate(v as any) : false));
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
        if (!semantic || (upsertCount === 0 && deleteCount === 0)) {
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
                const level = (m as any)?.hitl || (m as any)?.policyParams?.hitl;
                const safety = (m as any)?.safety || {};
                if (!level) return { action: 'pass', intent: a } as any;
                // guardrails: block tools/subagents without explicit consent
                if (level === 'guardrails' && (a as any)?.kind && ((a as any).kind === 'call_tool' || (a as any).kind === 'delegate_to_child')) {
                    (m as any).lastAdvise = { kind: (a as any).kind, policy: 'guardrails' };
                    return { action: 'defer', askUser: 'Approve action?' } as any;
                }
                // consent: ask user before tools
                if (level === 'consent' && (a as any)?.kind === 'call_tool') {
                    (m as any).lastAdvise = { kind: (a as any).kind, tool: (a as any).toolName, toolArgs: (a as any).args, policy: 'consent' };
                    return { action: 'defer', askUser: `Run tool ${(a as any).toolName}?` } as any;
                }
                // cost limit: if action declares cost in args, block if above threshold
                try {
                    const cost = Number(((a as any)?.args?.cost) ?? 0);
                    if (Number.isFinite(cost) && typeof safety.costLimit === 'number' && cost > safety.costLimit) {
                        (m as any).lastAdvise = { blocked: 'cost', cost, limit: safety.costLimit };
                        return { action: 'defer', askUser: `Action cost ${cost} exceeds limit ${safety.costLimit}. Proceed?` } as any;
                    }
                } catch { /* noop */ }
                // PII patterns: if args contain strings matching any configured pattern, prompt
                try {
                    const patterns: string[] = Array.isArray(safety.piiPatterns) ? safety.piiPatterns : [];
                    if (patterns.length > 0) {
                        const regexes = patterns.map(p => new RegExp(p, 'i'));
                        // Helper to recursively check objects/arrays
                        const scanForPII = (v: any): boolean => {
                            if (typeof v === 'string') return regexes.some(r => r.test(v));
                            if (Array.isArray(v)) return v.some(scanForPII);
                            if (v && typeof v === 'object') return Object.values(v).some(scanForPII);
                            return false;
                        };
                        const containsPII = scanForPII((a as any)?.args);
                        if (containsPII) {
                            (m as any).lastAdvise = { flagged: 'pii' };
                            return { action: 'defer', askUser: `Action contains potential PII. Proceed?` } as any;
                        }
                    }
                } catch { /* noop */ }
                // advise: allow but could tag; default pass-through here
                if (level === 'advise') {
                    (m as any).lastAdvise = { kind: (a as any).kind, policy: 'advise' };
                }
                return { action: 'pass', intent: a } as any;
            } catch { return { action: 'pass', intent: a } as any; }
        }),
        execution: modules.execution ?? (async (a: any, ctx: any, _mem) => {
            const kind = (a as any).kind;
            const base: ExecResult = { status: 'ok', ts: Date.now() };

            if (kind === 'prompt_user') {
                const handle = await (ctx as any).requestInput((a as any).prompt, {
                    schema: (a as any).schema,
                    onProvided: '__onInputProvided'
                });
                const token = (handle as any)?.token || '';
                try { log.info('Execution asking for user input', { token }); } catch { }
                return {
                    action: { kind: 'prompt_user', token } as ExecutableAction,
                    result: {
                        ...base,
                        data: { prompt: (a as any).prompt },
                        correlationId: token || undefined,
                        toolId: 'user'
                    }
                };
            }

            if (kind === 'delegate_to_child') {
                // FLUSH BEFORE DISPATCH: Ensure DB has current state (including M) so child creation (which loads parent) sees valid data.
                if (typeof (ctx as any).flushSnapshot === 'function') {
                    try {
                        log.debug('LoopRunner: calling flushSnapshot before subagent', { toolId: (a as any).agentId });
                        await (ctx as any).flushSnapshot({ M, env });
                    } catch (e) {
                        log.warn('Failed to flush snapshot before subagent dispatch', { error: (e as Error).message });
                    }
                } else {
                    log.warn('LoopRunner: flushSnapshot not available on context for subagent dispatch');
                }

                const res = await (ctx as any).sendTaskToAgent((a as any).agentId, (a as any).input, {
                    onCompleted: '__onChildCompleted'
                });
                const token = (res as any)?.token || (res as any)?.childToken;
                if (token) {
                    return {
                        action: { kind: 'delegate_to_child', token } as ExecutableAction,
                        result: { ...base, correlationId: token, toolId: (a as any).agentId }
                    };
                }
                return {
                    action: { kind: 'delegate_to_child' } as ExecutableAction,
                    result: { ...base, data: res, toolId: (a as any).agentId }
                };
            }

            if (kind === 'call_tool') {
                const toolName = (a as any).toolName;

                // FLUSH BEFORE TOOL: Some tools might inspect agent state via DB or side-channels
                if (typeof (ctx as any).flushSnapshot === 'function') {
                    try {
                        log.debug('LoopRunner: calling flushSnapshot before tool', { toolId: toolName });
                        await (ctx as any).flushSnapshot({ M, env });
                    } catch (e) {
                        log.warn('Failed to flush snapshot before tool execution', { error: (e as Error).message });
                    }
                } else {
                    log.debug('LoopRunner: flushSnapshot not available on context for tool execution', { toolId: toolName });
                }

                if ((a as any).mode === 'async') {
                    const handle = await (ctx as any).requestTool(toolName, (a as any).args, {
                        onCompleted: '__onToolCompleted'
                    });
                    const token = (handle as any)?.token || '';
                    return {
                        action: { kind: 'call_tool', token } as ExecutableAction,
                        result: { ...base, correlationId: token || undefined, toolId: toolName }
                    };
                }
                try {
                    const result = await (ctx as any).tools.invoke(toolName, (a as any).args);
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

            if (kind === 'answer_with_llm') {
                await (ctx as any).reply((a as any).query);
                return {
                    action: { kind: 'answer_with_llm', echoed: true } as ExecutableAction,
                    result: { ...base, data: { echoed: true, query: (a as any).query }, toolId: 'language' }
                };
            }

            if (kind === 'create_plan') {
                // Placeholder: In a real agent, this would use an LLM or planner
                return {
                    action: { kind: 'internal' } as ExecutableAction,
                    result: { ...base, data: { planProposed: { id: `plan_${Date.now()}`, goalId: (a as any).goalId, steps: [], status: 'proposed' } }, toolId: 'internal' }
                };
            }

            return {
                action: { kind: 'internal', done: (a as any).done || false } as ExecutableAction,
                result: { ...base, data: { intent: (a as any).intent, done: (a as any).done || false }, toolId: 'internal' }
            };
        }),
        transition: modules.transition ?? ((env, exec, _m, _mem) => {
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

                if (action.kind === 'internal' && (action as any).done === true) {
                    return { kind: 'complete', observations: [] as Observation[] } as TransitionOut;
                }

                // Planning transitions
                const data = result.data as any;
                const obs: Observation[] = [];
                if (data?.planProposed) {
                    obs.push({ source: 'internal', kind: 'plan.proposed', payload: data.planProposed });
                }
                if (data?.planUpdated) {
                    obs.push({ source: 'internal', kind: 'plan.updated', payload: data.planUpdated });
                }
                if (data?.planStepUpdated) {
                    obs.push({ source: 'internal', kind: 'plan.step.updated', payload: data.planStepUpdated });
                }

                if (obs.length === 0) {
                    obs.push({
                        source: 'internal',
                        kind: 'state.noted',
                        payload: {
                            intent: (action as any).intent || action.kind,
                            reason: 'continue_implicit'
                        }
                    });
                }

                return { kind: 'continue', observations: obs } as TransitionOut;

            }

            // Error path
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
            } catch (err) {
                log.warn('Failed to start iteration TurnNode', { error: err });
            }
            // -----------------------

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
            const turnId = uuidv7();
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

            const usage = iCtx.__turnUsage
                ? { ...iCtx.__turnUsage }
                : undefined;
            if (iCtx.__turnLlmCalls?.length && usage) {
                usage.llmCalls = iCtx.__turnLlmCalls.length;
            }
            if (iCtx.__turnToolCalls?.length && usage) {
                usage.toolCalls = iCtx.__turnToolCalls.length;
            }
            if (iCtx.__turnChildCalls?.length && usage) {
                usage.childCalls = iCtx.__turnChildCalls.length;
            }

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
                correlationId,
                traceId,
                spanId,
                parentSpanId: iterationTurnNode?.parentId,
                llmCalls: iCtx.__turnLlmCalls,
                toolCalls: iCtx.__turnToolCalls,
                childCalls: iCtx.__turnChildCalls,
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
                if (turnOpikDiagEnabled()) {
                    log.info('[CALLAGENT_DEBUG_TURN_OPIK] loopRunner emitTurnTrace', {
                        envTurn: turn,
                        loopTurnIdx: turnIdx,
                        traceId: trace.traceId,
                        spanId: trace.spanId,
                        parentSpanId: trace.parentSpanId,
                        transitionKind: trace.transition?.kind,
                        stageAfter: trace.stageAfter,
                        taskId: (ctx as { task?: { id?: string } }).task?.id,
                        agentId: (ctx as { agentId?: string }).agentId,
                    });
                }
                telemetry.emitTurnTrace(trace);
            } catch (emitErr) {
                log.warn('TurnTrace emission failed', {
                    error: emitErr instanceof Error ? emitErr.message : String(emitErr),
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
                inbox.all.push(...observations);
                inbox.current = [...observations];
            } else {
                // Hygiene: avoid having "phantom" observations by mistake 
                // if next turn starts without them being cleared. 
                // Perception is responsible for filling them.
                env.inbox.current = [];
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
            if (error instanceof InvariantError) throw error;
            console.error(`[LoopRunner] 🛑 FATAL: Turn ${turn} failed with exception!`, error);
            log.error(`Turn ${turn} failed`, { error: error instanceof Error ? error.message : String(error) });
            outcome = {
                kind: 'fail',
                reason: `turn_${turnIdx}_error: ${error instanceof Error ? error.message : String(error)}`
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


        // Stop on await_* or terminal
        // 🔍 DEBUG: Log loop continuation check
        console.log(`[LoopRunner] Checking outcome. Kind: ${outcome.kind}`);
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
                    (o: any) => o.kind === 'child.completed' && o.payload?.token === awaitToken
                ) || env.inbox.all.some(
                    (o: any) => o.kind === 'child.completed' && o.payload?.token === awaitToken
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
                                        (o: any) => o.kind === 'child.completed' && o.payload?.token === awaitToken
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
                        (o: any) => o.kind === 'child.completed' && o.payload?.token === awaitToken
                    ) || env.inbox.all.find(
                        (o: any) => o.kind === 'child.completed' && o.payload?.token === awaitToken
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
                if (outcome.kind === 'await_input' || outcome.kind === 'await_tool' || outcome.kind === 'await_child') {
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
