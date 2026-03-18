import { z } from 'zod';
import type { TaskContext } from '../shared/types/index.js';

// ─── Zod schemas ─────────────────────────────────────────────────────────────

export const StageInvariantRuleSchema = z
    .object({
        require: z.array(z.string()).optional(),
        forbid: z.array(z.string()).optional(),
    })
    .strict();

export type StageInvariantRule = z.infer<typeof StageInvariantRuleSchema>;

export type StageInvariantMap<St extends string> = Partial<Record<St, StageInvariantRule>>;

/** Runtime validation at creation time; pass stages array for enum validation. */
export function createStageFacadeConfigSchema<St extends string>(stages: readonly St[]) {
    const stageSet = new Set(stages);
    const stageEnum = z.enum(stages as unknown as [string, ...string[]]);
    const optionalInvariants = z
        .record(z.string(), StageInvariantRuleSchema)
        .optional()
        .refine(
            (rec) => !rec || Object.keys(rec).every((k) => stageSet.has(k as St)),
            { message: 'invariants keys must be valid stages' }
        );
    const optionalAutoMarks = z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .refine(
            (rec) => !rec || Object.keys(rec).every((k) => stageSet.has(k as St)),
            { message: 'autoMarks keys must be valid stages' }
        );
    const optionalOnEnter = z
        .record(z.string(), z.any())
        .optional()
        .refine(
            (rec) => !rec || Object.keys(rec).every((k) => stageSet.has(k as St)),
            { message: 'onEnter keys must be valid stages' }
        );
    return z
        .object({
            stageKey: z.string().min(1).default('stage'),
            initial: stageEnum,
            invariants: optionalInvariants,
            autoMarks: optionalAutoMarks,
            onEnter: optionalOnEnter,
        })
        .strict();
}

// ─── Public types ────────────────────────────────────────────────────────────

export type StageEnterContext = {
    progress: (pct: number, message: string) => void;
    complete: (pct: number, message: string) => void;
};

export type StageInvariantCheckResult = {
    required?: string[];
    forbidden?: string[];
    ok: boolean;
    failedKey?: string;
};

export type StageTransitionResult<St extends string> = {
    from: St;
    to: St;
    autoMarksApplied: string[];
    invariantChecks: StageInvariantCheckResult[];
};

/** Written to InternalTaskContext.__stageTrace by StageFacade.set(); consumed by oneTurn/loopRunner for TurnTrace. */
export type StageTraceEntry = {
    stageBefore: string;
    stageAfter: string;
    stageTransition: { from: string; to: string };
    stageAutoMarksApplied: string[];
    stageInvariantChecks: StageInvariantCheckResult[];
};

/** Normalized, non-leaky shape for trace/harness. Does not expose raw control keys. */
export type StageSummary<St extends string> = {
    current: St;
    hasPendingInput: boolean;
    hasPendingTool: boolean;
    hasPendingChild: boolean;
    markCount: number;
};

export type StageFacade<St extends string> = {
    get: (ctx: TaskContext) => St;
    set: (ctx: TaskContext, stage: St) => StageTransitionResult<St>;
    is: (ctx: TaskContext, stage: St) => boolean;
    assert: (ctx: TaskContext, stage?: St) => void;
    summary: (ctx: TaskContext) => StageSummary<St>;
};

export type ControlKeyMap = Record<string, string>;

export type CreateStageFacadeOptions<St extends string> = {
    stages: readonly St[];
    stageKey?: string;
    initial: St;
    invariants?: Partial<Record<St, StageInvariantRule>>;
    autoMarks?: Partial<Record<St, Record<string, unknown>>>;
    onEnter?: Partial<Record<St, (ctx: StageEnterContext, stage: St) => void>>;
};

/** Helper for typed control keys; returns a frozen map. */
export function defineControlKeys<T extends ControlKeyMap>(keys: T): Readonly<T> {
    return Object.freeze(keys);
}
