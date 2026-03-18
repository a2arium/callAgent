import type { TaskContext } from '../shared/types/index.js';
import { throwInvariantError } from '../utils/invariantError.js';
import type { EnvironmentState } from './types.js';
import type { MentalState } from './types.js';

export type StageInvariants<St extends string> = Partial<Record<St, {
    require?: string[];
    forbid?: string[];
}>>;

/**
 * Internal interface for TaskContext that includes loop-related properties
 */
interface InternalTaskContext extends TaskContext {
    controlVars?: Record<string, unknown> | Map<string, unknown>;
    __activeLoopEnv?: EnvironmentState;
    env?: {
        control?: {
            pendingSnapshot?: {
                controlVars?: Record<string, unknown>;
            };
        };
    };
    M?: MentalState;
}

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
        const iCtx = ctx as InternalTaskContext;
        const controlVars = iCtx.controlVars
            || iCtx.__activeLoopEnv?.pending?.controlVars
            || iCtx.env?.control?.pendingSnapshot?.controlVars;
        if (controlVars) {
            if (typeof (controlVars as Record<string, unknown>).get === 'function') {
                const val = (controlVars as { get: (k: string) => unknown }).get(key);
                if (typeof val !== 'undefined') return val;
            }
            if (Object.prototype.hasOwnProperty.call(controlVars, key)) {
                return (controlVars as Record<string, unknown>)[key];
            }
        }
        return undefined;
    };

    const setControlVar = (ctx: TaskContext, key: string, value: unknown): void => {
        const iCtx = ctx as InternalTaskContext;
        // Update local controlVars bag
        const existing = iCtx.controlVars;
        if (existing && typeof (existing as any).set === 'function') {
            (existing as any).set(key, value);
        } else {
            iCtx.controlVars = { ...(typeof existing === 'object' ? existing : {}), [key]: value };
        }
        // Mirror into active loop env pending.controlVars when present
        const env = iCtx.__activeLoopEnv;
        if (env) {
            env.pending = env.pending || { inputs: {}, children: {}, tools: {}, groups: {} };
            env.pending.controlVars = { ...(env.pending.controlVars || {}), [key]: value };
        }
    };

    const getStage = (ctx: TaskContext): St =>
        ((readVar(ctx, stageKey) as St | undefined)
        ?? (initial as St));

    const assertStage = (ctx: TaskContext, s: St): void => {
        const iCtx = ctx as InternalTaskContext;
        const r = (rules[s] || {}) as { require?: string[]; forbid?: string[] };
        const pendingSnapshot = iCtx.__activeLoopEnv?.pending;

        for (const k of r.require ?? []) {
            if (readVar(ctx, k) === undefined) {
                throwInvariantError(
                    'STAGE_REQUIRES_KEY',
                    `[invariant] ${s} requires ${k}`,
                    {
                        type: 'stage_invariant',
                        stage: s,
                        required: [k],
                        pendingSnapshot
                    }
                );
            }
        }
        for (const k of r.forbid ?? []) {
            if (readVar(ctx, k) !== undefined) {
                throwInvariantError(
                    'STAGE_FORBIDS_KEY',
                    `[invariant] ${s} forbids ${k}`,
                    {
                        type: 'stage_invariant',
                        stage: s,
                        forbidden: [k],
                        pendingSnapshot
                    }
                );
            }
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


