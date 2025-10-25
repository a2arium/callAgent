import type { TaskContext } from '../shared/types/index.js';
import { oneTurn, type Modules, type TurnOutcome, type ProposedAction } from './oneTurn.js';
import type { EnvironmentState, MentalState } from './types.js';

type LoopRunnerOptions = {
    maxTurns?: number;
    latencyMs?: number;
};

export async function runLoop(
    ctx: TaskContext,
    M: MentalState,
    env: EnvironmentState,
    modules: Partial<Modules>,
    opts: LoopRunnerOptions = {}
): Promise<{ M: MentalState; outcome: TurnOutcome; metrics?: { timings: Record<string, number>[]; rewards: number[] } }> {
    const start = Date.now();
    const maxTurns = opts.maxTurns ?? 10; // default safety budget
    try { console.info('[loopRunner] start', { maxTurns }); } catch { }

    // Provide minimal defaults (prefer agent overrides when present)
    const defaults: Modules = {
        attention: modules.attention ?? ((_prev, _env) => ({ kind: 'all' })),
        perception: modules.perception ?? ((e: EnvironmentState) => {
            try {
                // import via dynamic require to avoid ESM circulars in tests
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { sanitizeObservation } = require('./sanitize.js');
                // Allow manifest to disable sanitization
                const shouldSanitize = ((M as any)?.safety?.sanitize) !== false;
                const safeInput = shouldSanitize ? sanitizeObservation(e.input) : e.input;
                return { input: safeInput, time: e.time, pending: e.pending } as any;
            } catch {
                return { input: e.input, time: e.time, pending: e.pending } as any;
            }
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
            if (kind === 'ask_user') {
                const handle = await (ctx as any).requestInput((a as any).prompt, { schema: (a as any).schema, onProvided: '__onInputProvided' });
                const token = (handle as any)?.token || '';
                try { console.log(`[LoopRunner] execution ask_user -> token=${token}`); } catch { }
                return { kind: 'ask_user', token } as any;
            }
            if (kind === 'subagent') {
                const res = await (ctx as any).sendTaskToAgent((a as any).target, (a as any).input, { onCompleted: '__onChildCompleted' });
                const token = (res as any)?.token || (res as any)?.childToken;
                if (token) return { kind: 'subagent', token } as any;
                return { kind: 'subagent', result: res } as any;
            }
            if (kind === 'tool') {
                // If awaitCallback requested, register as external tool and await
                if ((a as any).awaitCallback) {
                    const handle = await (ctx as any).requestTool((a as any).name, (a as any).args, { onCompleted: '__onToolCompleted' });
                    const token = (handle as any)?.token || '';
                    return { kind: 'tool', token } as any;
                }
                const result = await (ctx as any).tools.invoke((a as any).name, (a as any).args);
                // Store result for multi-step planners
                try {
                    const st = ((M as any)?.memory) || {};
                    (M as any).memory = { ...st, scratch: { ...(st.scratch || {}), react: { ...((st.scratch || {}).react || {}), lastResult: result } } };
                } catch { /* noop */ }
                return { kind: 'tool', result } as any;
            }
            if (kind === 'language') {
                await (ctx as any).reply((a as any).content);
                return { kind: 'language', echoed: true } as any;
            }
            return { kind: 'internal', done: true } as any;
        }),
        transition: modules.transition ?? ((env, exec, m) => {
            const k = (exec as any).kind;
            if (k === 'ask_user') {
                const t = (exec as any).token;
                try { console.log(`[LoopRunner] transition await_input token=${t}`); } catch { }
                return { kind: 'await_input', token: t } as any;
            }
            // Safety: if an ask_user ProposedAction was executed but transition is not await_*, log and fail
            try {
                const lastIntent = (env as any)?.lastIntentKind;
                if (lastIntent === 'ask_user' && k !== 'ask_user') {
                    console.warn('[LoopRunner] Transition did not return await_* after ask_user; failing turn');
                    return { kind: 'fail', reason: 'transition_missing_await_after_ask_user' } as any;
                }
            } catch { /* noop */ }
            if (k === 'subagent' && (exec as any).token) return { kind: 'await_child', token: (exec as any).token } as any;
            if (k === 'tool' && (exec as any).token) return { kind: 'await_tool', token: (exec as any).token } as any;
            // Enrich env goal stats (best-effort)
            try {
                const nodes = ((m as any)?.goalState?.hierarchy?.nodes) || {};
                const doneCount = Object.values(nodes as any).filter((n: any) => n?.status === 'done').length;
                (env as any).goalStats = { doneCount };
            } catch { /* noop */ }
            return { kind: 'continue' } as any;
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
    } as Modules;

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
    let outcome: TurnOutcome = { kind: 'continue' };
    const timings: Record<string, number>[] = [];
    const rewards: number[] = [];

    // env.turn is already set correctly by taskEngine for the first turn
    for (let turn = 0; turn < maxTurns; turn++) {
        // expose current turn on ctx for usage attribution
        try { (ctx as any).__turn = (env as any).turn; } catch { }
        // For subsequent iterations in the same runLoop call, increment turn
        if (turn > 0) {
            try { (env as any).turn += 1; } catch { }
        }
        if (opts.latencyMs && Date.now() - start > opts.latencyMs) {
            outcome = { kind: 'fail', reason: 'budget_latency_exceeded' };
            break;
        }

        try {
            const step: Awaited<ReturnType<typeof oneTurn>> = await oneTurn(ctx, env, m, defaults, prevAction, rPrev);
            m = step.m;
            outcome = step.outcome;
            if (step.timings) timings.push(step.timings);
            rewards.push(step.reward || 0);
        } catch (error) {
            console.error(`[loopRunner] Turn ${turn} failed:`, error);
            outcome = {
                kind: 'fail',
                reason: `turn_${turn}_error: ${error instanceof Error ? error.message : String(error)}`
            };
            break;
        }

        // Stop on await_* or terminal
        if (outcome.kind !== 'continue') break;
        if (turn === maxTurns - 1) {
            outcome = { kind: 'fail', reason: 'budget_turns_exceeded' };
            break;
        }
        // no-op
    }

    return { M: m, outcome, metrics: timings.length ? { timings, rewards } : undefined };
}


