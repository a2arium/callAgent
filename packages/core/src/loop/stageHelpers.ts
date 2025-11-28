import type { TaskContext } from '../shared/types/index.js';

export type StageInvariants<St extends string> = Partial<Record<St, {
    require?: string[];
    forbid?: string[];
}>>;

export function createStageFacade<St extends string = string>(opts: {
    stageKey?: string;
    initial?: St;
    invariants?: StageInvariants<St>;
    autoMarks?: Partial<Record<St, Record<string, unknown>>>; // keys to set when entering stage
    onEnter?: Partial<Record<St, (ctx: TaskContext, stage: St) => void>>;
} = {}) {
    const stageKey = opts.stageKey ?? 'stage';
    const initial = opts.initial as St | undefined;
    const rules = (opts.invariants ?? {}) as StageInvariants<St>;

    const readVar = (ctx: TaskContext, key: string): unknown => {
        // Prefer controlVars (control state), then fallback to legacy memory vars for compatibility
        const controlVars = (ctx as any).controlVars
            || (ctx as any).__activeLoopEnv?.pending?.controlVars
            || (ctx as any).env?.control?.pendingSnapshot?.controlVars;
        if (controlVars) {
            if (typeof (controlVars as any).get === 'function') {
                const val = (controlVars as any).get(key);
                if (typeof val !== 'undefined') return val;
            } else if (Object.prototype.hasOwnProperty.call(controlVars, key)) {
                return (controlVars as any)[key];
            }
        }
        const memoryVars = (ctx.M as any)?.memory?.vars;
        return memoryVars ? (memoryVars as Record<string, unknown>)[key] : undefined;
    };

    const setControlVar = (ctx: TaskContext, key: string, value: unknown): void => {
        // Update local controlVars bag
        const existing = (ctx as any).controlVars;
        if (existing && typeof (existing as any).set === 'function') {
            (existing as any).set(key, value);
        } else {
            (ctx as any).controlVars = { ...(typeof existing === 'object' ? existing : {}), [key]: value };
        }
        // Mirror into active loop env pending.controlVars when present
        const env = (ctx as any).__activeLoopEnv;
        if (env) {
            env.pending = env.pending || { inputs: {}, children: {}, tools: {}, groups: {} };
            env.pending.controlVars = { ...(env.pending.controlVars || {}), [key]: value };
        }
    };

    const getStage = (ctx: TaskContext): St =>
        ((readVar(ctx, stageKey) as St | undefined)
        ?? (initial as St));

    const assertStage = (ctx: TaskContext, s: St): void => {
        const r = (rules[s] || {}) as { require?: string[]; forbid?: string[] };
        for (const k of r.require ?? []) {
            if (readVar(ctx, k) === undefined) throw new Error(`[invariant] ${s} requires ${k}`);
        }
        for (const k of r.forbid ?? []) {
            if (readVar(ctx, k) !== undefined) throw new Error(`[invariant] ${s} forbids ${k}`);
        }
    };

    const setStage = (ctx: TaskContext, s: St): void => {
        assertStage(ctx, s);
        setControlVar(ctx, stageKey, s);
        const autoMarks = (opts.autoMarks ?? {}) as Partial<Record<St, Record<string, unknown>>>;
        const marks = autoMarks[s];
        if (marks) {
            for (const [k, v] of Object.entries(marks)) {
                setControlVar(ctx, k, v as unknown);
            }
        }
        const onEnter = (opts.onEnter ?? {}) as Partial<Record<St, (ctx: TaskContext, stage: St) => void>>;
        const hook = onEnter[s];
        if (hook) {
            hook(ctx, s);
        }
    };

    return { getStage, setStage, assertStage };
}

