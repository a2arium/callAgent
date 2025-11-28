import type { TaskContext } from '../shared/types/index.js';
import {
    oneTurn,
    type Modules,
    type TurnOutcome,
    type TransitionOut,
    type ProposedAction,
    type ExecutableAction,
    type ExecResult,
    type ExecErrorPayload,
    type AttentionSignal,
    type SynthesizeObservation,
    type ObservationConfig
} from './oneTurn.js';
import { normalizeObservationInbox, type EnvironmentState, type MentalState, type ObservationInbox } from './types.js';
import { logger, updateLoggingContext } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'runLoop' });

type LoopRunnerOptions = {
    maxTurns?: number;
    latencyMs?: number;
};

const ensureInbox = <ObservationPayload extends ObservationConfig = ObservationConfig>(environment: EnvironmentState<ObservationPayload>): ObservationInbox<ObservationPayload> => {
    const normalized = normalizeObservationInbox<ObservationPayload>(environment.inbox);
    environment.inbox = normalized;
    return normalized;
};

export async function runLoop<
    Sensory = unknown,
    Obs = SynthesizeObservation<ObservationConfig>,
    Alpha = AttentionSignal,
    ExecData = unknown,
    ExecError extends import('./oneTurn.js').ExecErrorPayload = import('./oneTurn.js').ExecErrorPayload,
    ObservationPayload extends ObservationConfig = ObservationConfig
>(
    ctx: TaskContext,
    M: MentalState<Sensory>,
    env: EnvironmentState<ObservationPayload>,
    modules: Partial<Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObservationPayload>>,
    opts: LoopRunnerOptions = {}
): Promise<{
    M: MentalState<Sensory>;
    outcome: TurnOutcome<ObservationPayload>;
    metrics?: { timings: Record<string, number>[]; rewards: number[] };
}> {
    // DIAGNOSTIC: Unique ID for this runLoop execution to detect race conditions
    const runId = Math.random().toString(36).substring(2, 8);
    const taskId = ctx.task.id.substring(0, 20);
    log.debug('runLoop started', { taskId, runId });

    const start = Date.now();
    const maxTurns = opts.maxTurns ?? Infinity; // no default - respect manifest values
    try { log.info('LoopRunner started', { maxTurns }); } catch { }

    const inbox = ensureInbox(env);

    // Initialize control snapshot on env for modules that need control signals
    try {
        (env as any).control = {
            pendingSnapshot: env.pending,
            lastExec: env.lastExec
        };
    } catch { /* noop */ }

    // ✅ FIX: Store inbox reference on context so handleChildCompleted can update it directly
    // This allows synchronous child completions to be visible to the loop's await_child check
    (ctx as any).__activeLoopInbox = inbox;
    // ✅ FIX: Store env reference so synchronous completions can update pending state
    (ctx as any).__activeLoopEnv = env;

    log.info('LoopRunner: Attached __activeLoopInbox to context (v3.5)', { taskId, hasInbox: !!inbox, inboxLen: inbox.current.length });

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
            world: { get: async () => (mState as any)?.worldModel },
            goals: { get: async () => (mState as any)?.goalState?.hierarchy || { nodes: {}, roots: [] } },
            policy: { getParams: async () => (mState as any)?.policyParams },
            reward: { getParams: async () => (mState as any)?.rewardParams }
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
            rewardParamsReplace: undefined as import('./types.js').MentalState['rewardParams'] | undefined
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
                if (patches.worldReplace) (next as any).worldModel = patches.worldReplace;
                if (patches.goalsReplace) (next as any).goalState = { ...(next as any).goalState, hierarchy: patches.goalsReplace };
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
        if (semantic) {
            try {
                for (const [id, item] of patches.semanticUpserts.entries()) {
                    await semantic.set?.(id, item.data ?? item, { tags: (item as any).tags, entities: (item as any).entities });
                }
                for (const id of patches.semanticDeletes.values()) {
                    await semantic.delete?.(id);
                }
            } catch (err) {
                log.warn('Failed to flush semantic patches', { error: err instanceof Error ? err.message : String(err) });
            }
        }
        // Episodic/procedural/world/goals/policy/reward are persisted via MentalState snapshot
    };

    // Provide minimal defaults (prefer agent overrides when present)
    const defaults: Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObservationPayload> = {
        attention: modules.attention ?? ((_prev, _env, _mem) => ({ kind: 'all' })),
        perception: modules.perception ?? ((e: EnvironmentState<ObservationPayload>, _alpha: Alpha, _mem) => {
            const inboxState = ensureInbox(e);
            const turnInbox = Array.isArray(inboxState.current) ? [...inboxState.current] : [];
            // Default perception returns inbox observations
            return { time: e.time, pending: e.pending, inbox: turnInbox } as any;
        }),
        learning: modules.learning ?? ((prev, _prevAction, obs, _mem, writer) => {
            const next = { ...(prev as any) } as MentalState<Sensory>;
            try {
                const episodic = Array.isArray((next as any).memory?.longTerm?.episodic)
                    ? [...(next as any).memory.longTerm.episodic]
                    : [];
                const event = { t: Date.now(), obs, act: undefined } as any;
                episodic.push(event);
                ((next as any).memory.longTerm as any).episodic = episodic;
                (writer as any).episodic?.append?.(event);
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
                            return { kind: 'tool', name: p.tool, args: refinedArgs } as any;
                        }
                    } catch { /* ignore bad regex */ }
                }
            }
            return { kind: 'language', content: 'Ok.' } as any;
        }),
        shield: modules.shield ?? ((m, a, _mem) => {
            try {
                const level = (m as any)?.hitl || (m as any)?.policyParams?.hitl;
                const safety = (m as any)?.safety || {};
                if (!level) return { action: 'pass', intent: a } as any;
                // guardrails: block tools/subagents without explicit consent
                if (level === 'guardrails' && (a as any)?.kind && ((a as any).kind === 'tool' || (a as any).kind === 'subagent')) {
                    (m as any).lastAdvise = { kind: (a as any).kind, policy: 'guardrails' };
                    return { action: 'defer', askUser: 'Approve action?' } as any;
                }
                // consent: ask user before tools
                if (level === 'consent' && (a as any)?.kind === 'tool') {
                    (m as any).lastAdvise = { kind: (a as any).kind, tool: (a as any).name, toolArgs: (a as any).args, policy: 'consent' };
                    return { action: 'defer', askUser: `Run tool ${(a as any).name}?` } as any;
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
                        const containsPII = scanForPII((a as any)?.args, regexes);
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
        execution: modules.execution ?? (async (a, ctx, _mem) => {
            const kind = (a as any).kind;
            const base: ExecResult = { status: 'ok', ts: Date.now() };

            if (kind === 'ask_user') {
                const handle = await (ctx as any).requestInput((a as any).prompt, {
                    schema: (a as any).schema,
                    onProvided: '__onInputProvided'
                });
                const token = (handle as any)?.token || '';
                try { log.info('Execution asking for user input', { token }); } catch { }
                return {
                    action: { kind: 'ask_user', token } as ExecutableAction,
                    result: {
                        ...base,
                        data: { prompt: (a as any).prompt },
                        correlationId: token || undefined,
                        toolId: 'user'
                    }
                };
            }

            if (kind === 'subagent') {
                const res = await (ctx as any).sendTaskToAgent((a as any).target, (a as any).input, {
                    onCompleted: '__onChildCompleted'
                });
                const token = (res as any)?.token || (res as any)?.childToken;
                if (token) {
                    return {
                        action: { kind: 'subagent', token } as ExecutableAction,
                        result: { ...base, correlationId: token, toolId: (a as any).target }
                    };
                }
                return {
                    action: { kind: 'subagent' } as ExecutableAction,
                    result: { ...base, data: res, toolId: (a as any).target }
                };
            }

            if (kind === 'tool') {
                const toolName = (a as any).name;
                if ((a as any).awaitCallback) {
                    const handle = await (ctx as any).requestTool(toolName, (a as any).args, {
                        onCompleted: '__onToolCompleted'
                    });
                    const token = (handle as any)?.token || '';
                    return {
                        action: { kind: 'tool', token } as ExecutableAction,
                        result: { ...base, correlationId: token || undefined, toolId: toolName }
                    };
                }
                try {
                    const result = await (ctx as any).tools.invoke(toolName, (a as any).args);
                    return {
                        action: { kind: 'tool' } as ExecutableAction,
                        result: { ...base, data: result, toolId: toolName }
                    };
                } catch (error) {
                    return {
                        action: { kind: 'tool' } as ExecutableAction,
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

            if (kind === 'language') {
                await (ctx as any).reply((a as any).content);
                return {
                    action: { kind: 'language', echoed: true } as ExecutableAction,
                    result: { ...base, data: { echoed: true, content: (a as any).content }, toolId: 'language' }
                };
            }

            return {
                action: { kind: 'internal', done: true } as ExecutableAction,
                result: { ...base, data: { intent: (a as any).intent, done: true }, toolId: 'internal' }
            };
        }),
        transition: modules.transition ?? ((env, exec, _m, _mem) => {
            const { action, result } = exec;

            if (action.kind === 'ask_user' && action.token) {
                try { log.info('Transition to await_input', { token: action.token }); } catch { }
                return { kind: 'await_input', token: action.token } as TransitionOut<ObservationPayload>;
            }

            if (action.kind === 'subagent' && action.token) {
                return { kind: 'await_child', token: action.token } as TransitionOut<ObservationPayload>;
            }

            if (action.kind === 'tool' && action.token) {
                return { kind: 'await_tool', token: action.token } as TransitionOut<ObservationPayload>;
            }

            // ✅ FIX v3.5: Check if there are pending children even if action.kind !== 'subagent'
            // This handles cases where custom execution modules dispatch children but return { kind: 'internal' }
            const pendingChildren = env.pending?.children;
            if (pendingChildren && typeof pendingChildren === 'object') {
                const tokens = Object.keys(pendingChildren);
                if (tokens.length > 0) {
                    const firstToken = tokens[0];
                    try { log.info('Default transition: detected pending child, returning await_child', { token: firstToken?.substring(0, 15), totalPending: tokens.length }); } catch { }
                    return { kind: 'await_child', token: firstToken } as TransitionOut<ObservationPayload>;
                }
            }

            return { kind: 'continue', observations: [] as SynthesizeObservation<ObservationPayload>[] } as TransitionOut<ObservationPayload>;
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
    } as Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObservationPayload>;

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
    let prevAction: ProposedAction | undefined = undefined;
    let rPrev: number | undefined = undefined;
    let outcome: TurnOutcome<ObservationPayload> = { kind: 'continue', observations: [] };
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

    for (let turn = 0; turn < maxTurns; turn++) {
        // For subsequent iterations in the same runLoop call, increment turn
        if (turn > 0) {
            try { (env as any).turn += 1; } catch { }
        }

        // Check global budget from env (handles resume cases where local turn count resets)
        const globalMaxTurns = (env as any).budget?.maxTurns;
        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log(`[runLoop] Budget check: env.turn=${(env as any).turn}, globalMaxTurns=${globalMaxTurns}, condition=${(env as any).turn} > ${globalMaxTurns} = ${(env as any).turn > globalMaxTurns}`);
        }
        if (typeof globalMaxTurns === 'number' && (env as any).turn > globalMaxTurns) {
            log.debug('🔍 DEBUG: Global budget check triggered', {
                taskId,
                runId,
                envTurn: (env as any).turn,
                globalMaxTurns
            });
            if (process.env.DEBUG_BACKGROUND_TASKS) {
                console.log(`[runLoop] FAILING: budget_turns_exceeded because ${(env as any).turn} > ${globalMaxTurns}`);
            }
            outcome = { kind: 'fail', reason: 'budget_turns_exceeded' };
            break;
        }

        // Update logging context with current turn number
        updateLoggingContext({ turn: (env as any).turn });

        // 🔍 DEBUG: Log each iteration
        log.debug('🔍 DEBUG: Loop iteration', {
            taskId,
            runId,
            loopCounter: turn,
            envTurn: (env as any).turn,
            maxTurns,
            willCheckBudget: turn === maxTurns - 1
        });
        if (opts.latencyMs && Date.now() - start > opts.latencyMs) {
            outcome = { kind: 'fail', reason: 'budget_latency_exceeded' };
            break;
        }

        try {
            log.debug('Before oneTurn', { taskId, runId, turn });

            // ✅ FIX: Validate that ctx.memory exists before calling oneTurn
            if (!(ctx as any).memory) {
                log.warn('ctx.memory is undefined - this may cause errors if agent uses memory operations', {
                    taskId,
                    runId,
                    turn,
                    agentId: (ctx as any).agentId
                });
            }

            const memReader = createMemoryReader(m);
            const writer = createMemoryWriter();

            let step;
            try {
                step = await oneTurn<Sensory, Obs, Alpha, ExecData, ExecError, ObservationPayload>(
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
                    turn,
                    error: errorMessage,
                    stack: errorStack,
                    hasMemory: !!(ctx as any).memory,
                    memoryType: typeof (ctx as any).memory,
                    agentId: (ctx as any).agentId
                });
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

            // 🔍 DEBUG: Log transition outcome
            log.debug('🔍 DEBUG: Transition outcome', {
                taskId,
                runId,
                loopCounter: turn,
                envTurn: (env as any).turn,
                outcomeKind: outcome.kind,
                hasToken: !!(outcome as any).token,
                actionKind: (step.exec as any)?.action?.kind,
                execStatus: (step.exec as any)?.result?.status
            });

            if (outcome.kind === 'continue' && !Array.isArray((outcome as any).observations)) {
                outcome = { kind: 'continue', observations: [] } as TransitionOut<ObservationPayload>;
            }
            const observations = Array.isArray((outcome as any).observations)
                ? ((outcome as any).observations as SynthesizeObservation<ObservationPayload>[])
                : [];
            if (observations.length > 0) {
                inbox.all.push(...observations);
                inbox.current = [...observations];
            } else {
                // ✅ FIX: Don't clear inbox.current when there are no new observations!
                // Preserve existing observations (e.g., child completion observations staged synchronously)
                // The inbox is loaded from snapshot at start of turn, so it may already have staged observations
                // Only clear if we're explicitly told to (which we're not in this case)
                // inbox.current remains as-is from snapshot
            }
            if (step.timings) timings.push(step.timings);
            rewards.push(step.reward || 0);

            // Update control snapshot for downstream modules
            try {
                (env as any).control = {
                    pendingSnapshot: env.pending,
                    lastExec: step.exec
                };
            } catch { /* noop */ }
        } catch (error) {
            log.error(`Turn ${turn} failed`, { error: error instanceof Error ? error.message : String(error) });
            outcome = {
                kind: 'fail',
                reason: `turn_${turn}_error: ${error instanceof Error ? error.message : String(error)}`
            };
            break;
        }

        // Stop on await_* or terminal
        // 🔍 DEBUG: Log loop continuation check
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

                // First check local inbox
                let childResultInInbox = inbox.all.some(
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
                                        log.debug('🔄 SYNC CHILD: Found child result in database inbox', {
                                            taskId,
                                            awaitToken: awaitToken?.substring(0, 15)
                                        });
                                        // Merge fresh inbox into local inbox
                                        for (const obs of freshInbox.all) {
                                            if (!inbox.all.some((o: any) => o.kind === obs.kind && o.payload?.token === obs.payload?.token)) {
                                                inbox.all.push(obs);
                                            }
                                        }
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
                        loopCounter: turn,
                        envTurn: (env as any).turn,
                        awaitToken: awaitToken?.substring(0, 15)
                    });
                    // Move child completion to current inbox for next turn
                    const childObs = inbox.all.find(
                        (o: any) => o.kind === 'child.completed' && o.payload?.token === awaitToken
                    );
                    if (childObs) {
                        inbox.current = [childObs];
                    }

                    // ✅ FIX: Remove from pending children so next turn doesn't await again
                    // We deferred this removal from TaskEngine (injection) to here
                    if (env.pending && env.pending.children && awaitToken) {
                        delete env.pending.children[awaitToken];
                        log.debug('🔄 SYNC CHILD: Removed child from pending', { awaitToken: awaitToken?.substring(0, 15) });
                    }

                    // Convert await_child to continue so loop proceeds
                    outcome = { kind: 'continue', observations: [] } as TransitionOut<ObservationPayload>;
                    // Don't break - continue to next turn
                    continue;
                }
            }

            log.debug('🔍 DEBUG: Loop stopping (non-continue outcome)', {
                taskId,
                runId,
                loopCounter: turn,
                envTurn: (env as any).turn,
                outcomeKind: outcome.kind,
                hasToken: !!(outcome as any).token
            });
            break;
        }
        if (turn === maxTurns - 1) {
            // 🔍 DEBUG: Log budget check
            log.debug('🔍 DEBUG: Budget check triggered', {
                taskId,
                runId,
                loopCounter: turn,
                envTurn: (env as any).turn,
                maxTurns,
                condition: `${turn} === ${maxTurns} - 1`
            });
            if (process.env.DEBUG_BACKGROUND_TASKS) {
                console.log(`[runLoop] FAILING at turn ${turn} === ${maxTurns} - 1: budget_turns_exceeded`);
            }
            outcome = { kind: 'fail', reason: 'budget_turns_exceeded' };
            break;
        }
        // no-op
    }

    // DIAGNOSTIC: Log what runLoop is returning
    const finalVars = Object.keys(((m as any)?.memory?.vars) || {});
    log.debug('runLoop returning MentalState', {
        varsCount: finalVars.length,
        vars: finalVars
    });

    return { M: m, outcome, metrics: timings.length ? { timings, rewards } : undefined };
}
