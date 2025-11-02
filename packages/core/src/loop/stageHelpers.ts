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
} = {}) {
    const stageKey = opts.stageKey ?? 'stage';
    const initial = opts.initial as St | undefined;
    const rules = (opts.invariants ?? {}) as StageInvariants<St>;

    const readVar = (ctx: TaskContext, key: string): unknown => {
        const fromVars = ctx.vars.get(key);
        if (typeof fromVars !== 'undefined') return fromVars;
        const memoryVars = (ctx.M as any)?.memory?.vars;
        return memoryVars ? (memoryVars as Record<string, unknown>)[key] : undefined;
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
        ctx.vars.set(stageKey, s);
        const autoMarks = (opts.autoMarks ?? {}) as Partial<Record<St, Record<string, unknown>>>;
        const marks = autoMarks[s];
        if (marks) {
            for (const [k, v] of Object.entries(marks)) {
                ctx.vars.set(k, v as unknown);
            }
        }
    };

    return { getStage, setStage, assertStage };
}


