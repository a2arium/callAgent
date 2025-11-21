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
    type Observation,
    type AttentionSignal
} from './oneTurn.js';
import type { EnvironmentState, MentalState, ObservationInbox } from './types.js';
import { logger, updateLoggingContext } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'runLoop' });

type LoopRunnerOptions = {
    maxTurns?: number;
    latencyMs?: number;
};

const ensureInbox = <ObservationPayload = unknown>(environment: EnvironmentState<ObservationPayload>): ObservationInbox<ObservationPayload> => {
    const raw = environment.inbox as unknown;
    if (Array.isArray(raw)) {
        const legacy = raw as Observation<ObservationPayload>[];
        const converted: ObservationInbox<ObservationPayload> = { current: [...legacy], all: [...legacy] };
        environment.inbox = converted;
        return converted;
    }
    if (raw && typeof raw === 'object') {
        const candidate = raw as ObservationInbox<ObservationPayload>;
        if (!Array.isArray(candidate.current)) candidate.current = [];
        if (!Array.isArray(candidate.all)) candidate.all = [];
        environment.inbox = candidate;
        return candidate;
    }
    const initialized: ObservationInbox<ObservationPayload> = { current: [], all: [] };
    environment.inbox = initialized;
    return initialized;
};

export async function runLoop<
    Sensory = unknown,
    Obs = Observation,
    Alpha = AttentionSignal,
    ExecData = unknown,
    ExecError extends import('./oneTurn.js').ExecErrorPayload = import('./oneTurn.js').ExecErrorPayload,
    ObservationPayload = unknown
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

    // Provide minimal defaults (prefer agent overrides when present)
    const defaults: Modules<Sensory, Obs, Alpha, ExecData, ExecError, ObservationPayload> = {
        attention: modules.attention ?? ((_prev, _env) => ({ kind: 'all' })),
        perception: modules.perception ?? ((e: EnvironmentState) => {
            const inboxState = ensureInbox(e);
            const turnInbox = Array.isArray(inboxState.current) ? [...inboxState.current] : [];
            // Default perception returns inbox observations
            return { time: e.time, pending: e.pending, inbox: turnInbox } as any;
        }),
        learning: modules.learning ?? ((prev, _prevAction, obs) => {
            try {
                const episodic = (prev.memory.longTerm.episodic || []);
                episodic.push({ t: Date.now(), obs, act: undefined });
                (prev.memory.longTerm as any).episodic = episodic;
            } catch { /* noop */ }
            // Update lastObservation for ReAct patterns
            try {
                const input = (obs as any)?.input;
                const asString = typeof input === 'string' ? input : JSON.stringify(input);
                (prev.memory as any).sensory = { ...((prev.memory as any).sensory || {}), lastObservation: asString };
            } catch { /* noop */ }
            return prev;
        }),
        policy: modules.policy ?? ((m: MentalState) => {
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
        shield: modules.shield ?? ((m, a) => {
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
        execution: modules.execution ?? (async (a, ctx) => {
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
        transition: modules.transition ?? ((env, exec, m) => {
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

            const observations: Observation<ObservationPayload>[] = [];
            const mapSource = (): Observation<ObservationPayload>['source'] => {
                switch (action.kind) {
                    case 'tool':
                        return 'tool';
                    case 'subagent':
                        return 'child';
                    case 'ask_user':
                        return 'user';
                    case 'language':
                        return 'env';
                    default:
                        return 'internal';
                }
            };

            const payloadValue = (result.data ?? null) as ObservationPayload;
            const errorValue: ExecErrorPayload | undefined =
                result.status === 'error'
                    ? (result.error ?? { code: 'execution_error', message: 'Execution returned error' })
                    : undefined;

            const baseObservation: Observation<ObservationPayload> = {
                source: mapSource(),
                kind: `${action.kind}.${result.status}`,
                payload: payloadValue,
                provenance: {
                    ts: result.ts ?? Date.now(),
                    turn: (env as any)?.turn ?? 0,
                    id: result.correlationId ?? undefined,
                    toolId: result.toolId,
                    correlationId: result.correlationId
                },
                error: errorValue
            };

            // Only record successful/failed immediates; await branches returned above.
            observations.push(baseObservation);

            // Enrich env goal stats (best-effort)
            try {
                const nodes = ((m as any)?.goalState?.hierarchy?.nodes) || {};
                const doneCount = Object.values(nodes as any).filter((n: any) => n?.status === 'done').length;
                (env as any).goalStats = { doneCount };
            } catch { /* noop */ }

            return { kind: 'continue', observations } as TransitionOut<ObservationPayload>;
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
        intrinsicReward: modules.intrinsicReward ?? ((m, obs) => {
            try {
                const s = JSON.stringify(obs);
                const st = (m.memory as any);
                st.scratch = st.scratch || {};
                const scratch = st.scratch as any;
                scratch.__novelty = scratch.__novelty || [];
                const arr: string[] = scratch.__novelty as string[];
                const seen = new Set(arr);
                const isNew = !seen.has(s);
                if (isNew) {
                    arr.push(s);
                    if (arr.length > 128) arr.splice(0, arr.length - 128);
                    return 0.1;
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
            log.debug('Before oneTurn', { taskId, runId, turn, varsCount: Object.keys(((m as any).memory?.vars) || {}).length });

            // ✅ FIX: Validate that ctx.memory exists before calling oneTurn
            // This prevents "Cannot read properties of undefined (reading 'bind')" errors
            // when agents use ctx.memory.semantic or other memory operations
            if (!(ctx as any).memory) {
                log.warn('ctx.memory is undefined - this may cause errors if agent uses memory operations', {
                    taskId,
                    runId,
                    turn,
                    agentId: (ctx as any).agentId
                });
            }

            let step;
            try {
                step = await oneTurn<Sensory, Obs, Alpha, ExecData, ExecError, ObservationPayload>(
                    ctx,
                    env,
                    m,
                    defaults,
                    prevAction,
                    rPrev
                );
            } catch (turnError) {
                // ✅ FIX: Enhanced error logging to identify bind errors
                const errorMessage = turnError instanceof Error ? turnError.message : String(turnError);
                const errorStack = turnError instanceof Error ? turnError.stack : undefined;
                log.error('Turn execution failed', {
                    taskId,
                    runId,
                    turn,
                    error: errorMessage,
                    stack: errorStack,
                    hasMemory: !!(ctx as any).memory,
                    hasVars: !!(ctx as any).vars,
                    varsType: typeof (ctx as any).vars,
                    memoryType: typeof (ctx as any).memory,
                    agentId: (ctx as any).agentId
                });
                throw turnError;
            }
            log.debug('After oneTurn', { taskId, runId, turn, stepVarsCount: Object.keys(((step.m as any).memory?.vars) || {}).length });
            m = step.m;

            // ✅ FIX Bug #1E: Sync ctx.vars into m after each turn so next turn sees them
            // This ensures vars written via ctx.vars during Execution are visible to the next turn
            try {
                const ctxVars = (ctx as any).vars;
                if (ctxVars && typeof ctxVars === 'object' && m && (m as any).memory) {
                    const existingVars = ((m as any).memory.vars) || {};
                    const varsToMerge: Record<string, unknown> = {};

                    // Extract all vars from ctx.vars - use get() method for proxy
                    if (typeof ctxVars.keys === 'function') {
                        for (const key of ctxVars.keys()) {
                            const value = typeof ctxVars.get === 'function' ? ctxVars.get(key) : ctxVars[key];
                            if (value !== undefined) {
                                varsToMerge[key] = value;
                            }
                        }
                    }

                    // ✅ FIX Bug #1H: Only merge if varsToMerge has keys, otherwise keep Learning's vars!
                    // Don't overwrite Learning's vars with empty ctx.vars
                    if (Object.keys(varsToMerge).length > 0) {
                        (m as any).memory.vars = { ...existingVars, ...varsToMerge };
                        log.debug('Synced ctx.vars into m.memory.vars', { syncedVars: Object.keys(varsToMerge) });
                    } else {
                        log.debug('No ctx.vars to sync, keeping Learning vars', { learningVarsCount: Object.keys(existingVars).length });
                    }
                }
            } catch (syncError) {
                log.warn('Failed to sync ctx.vars into m', { error: syncError instanceof Error ? syncError.message : String(syncError) });
            }

            log.debug('After sync', { finalVarsCount: Object.keys(((m as any).memory?.vars) || {}).length });
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
                ? ((outcome as any).observations as Observation<ObservationPayload>[])
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


