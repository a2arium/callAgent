import type { TaskContext } from '../shared/types/index.js';
import {
    type StageFacade,
    type StageEnterContext,
    type StageTransitionResult,
    type StageInvariantCheckResult,
    type StageTraceEntry,
    type StageSummary,
    type StageInvariantRule,
    type CreateStageFacadeOptions,
    createStageFacadeConfigSchema,
} from '../types/stageFacade.js';
import { throwInvariantError } from '../utils/invariantError.js';
import { resolveControlVars, readControlVar, writeControlVar } from './controlVarAccessors.js';
import type { InternalTaskContext } from './internalContext.js';

function runInvariantChecks(
    snapshot: Record<string, unknown>,
    stage: string,
    rule: StageInvariantRule
): StageInvariantCheckResult[] {
    const results: StageInvariantCheckResult[] = [];
    for (const key of rule.require ?? []) {
        const ok = snapshot[key] !== undefined;
        results.push({ required: [key], ok, failedKey: ok ? undefined : key });
        if (!ok) {
            throwInvariantError('STAGE_REQUIRES_KEY', `[invariant] ${stage} requires ${key}`, {
                type: 'stage_invariant',
                stage,
                required: [key],
                pendingSnapshot: snapshot,
            });
        }
    }
    for (const key of rule.forbid ?? []) {
        const ok = snapshot[key] === undefined;
        results.push({ forbidden: [key], ok, failedKey: ok ? undefined : key });
        if (!ok) {
            throwInvariantError('STAGE_FORBIDS_KEY', `[invariant] ${stage} forbids ${key}`, {
                type: 'stage_invariant',
                stage,
                forbidden: [key],
                pendingSnapshot: snapshot,
            });
        }
    }
    return results;
}

export function createStageFacade<St extends string>(options: CreateStageFacadeOptions<St>): StageFacade<St> {
    const schema = createStageFacadeConfigSchema(options.stages);
    const parsed = schema.parse({
        stageKey: options.stageKey ?? 'stage',
        initial: options.initial,
        invariants: options.invariants,
        autoMarks: options.autoMarks,
        onEnter: options.onEnter,
    });

    const stageKey = parsed.stageKey;
    const initial = parsed.initial as St;
    const invariants = (parsed.invariants ?? {}) as Partial<Record<St, StageInvariantRule>>;
    const autoMarks = (parsed.autoMarks ?? {}) as Partial<Record<St, Record<string, unknown>>>;
    const onEnter = (parsed.onEnter ?? {}) as Partial<Record<St, (ctx: StageEnterContext, stage: St) => void>>;

    const getStage = (ctx: TaskContext): St => {
        const v = readControlVar(ctx, stageKey);
        return (v !== undefined && v !== null ? String(v) : initial) as St;
    };

    const makeStageEnterContext = (ctx: TaskContext): StageEnterContext => ({
        progress: (pct: number, message: string) => ctx.progress(pct, message),
        complete: (pct: number, message: string) => ctx.complete(pct, message),
    });

    const setStage = (ctx: TaskContext, to: St): StageTransitionResult<St> => {
        const iCtx = ctx as InternalTaskContext;
        const from = getStage(ctx) as St;

        const currentVars = resolveControlVars(ctx) ?? {};
        const marksForStage = autoMarks[to] ?? {};
        const wouldBe: Record<string, unknown> = { ...currentVars, [stageKey]: to, ...marksForStage };

        const rule = invariants[to];
        const invariantChecks: StageInvariantCheckResult[] = rule ? runInvariantChecks(wouldBe, to, rule) : [];

        writeControlVar(ctx, stageKey, to);
        const autoMarksApplied: string[] = [];
        for (const [k, v] of Object.entries(marksForStage)) {
            writeControlVar(ctx, k, v);
            autoMarksApplied.push(k);
        }

        const stageTransition = { from, to };
        const traceEntry: StageTraceEntry = {
            stageBefore: from,
            stageAfter: to,
            stageTransition,
            stageAutoMarksApplied: autoMarksApplied,
            stageInvariantChecks: invariantChecks,
        };
        iCtx.__stageTrace = traceEntry;

        const hook = onEnter[to];
        if (hook) {
            hook(makeStageEnterContext(ctx), to);
        }

        return {
            from,
            to,
            autoMarksApplied,
            invariantChecks,
        };
    };

    const isStage = (ctx: TaskContext, s: St): boolean => getStage(ctx) === s;

    const assertStage = (ctx: TaskContext, stage?: St): void => {
        const s = stage ?? getStage(ctx);
        const rule = invariants[s as St];
        if (!rule) return;
        const snapshot = resolveControlVars(ctx) ?? {};
        runInvariantChecks(snapshot, s, rule);
    };

    const summary = (ctx: TaskContext): StageSummary<St> => {
        const iCtx = ctx as InternalTaskContext;
        const controlVars = resolveControlVars(ctx);
        const current = getStage(ctx);
        let markCount = 0;
        if (controlVars) {
            for (const k of Object.keys(controlVars)) {
                if (k !== stageKey) markCount++;
            }
        }
        const pending = iCtx.__activeLoopEnv?.pending ?? {
            inputs: {},
            children: {},
            tools: {},
            groups: {},
        };
        return {
            current,
            hasPendingInput: Object.keys(pending.inputs ?? {}).length > 0,
            hasPendingTool: Object.keys(pending.tools ?? {}).length > 0,
            hasPendingChild: Object.keys(pending.children ?? {}).length > 0,
            markCount,
        };
    };

    return { get: getStage, set: setStage, is: isStage, assert: assertStage, summary };
}
