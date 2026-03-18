import type { TaskContext } from '../shared/types/index.js';
import { throwInvariantError } from '../utils/invariantError.js';
import type { StageInvariantRule } from '../types/stageFacade.js';
import { resolveControlVars } from './controlVarAccessors.js';
import type { InternalTaskContext } from './internalContext.js';

export type StageInvariantMap<St extends string> = Partial<Record<St, StageInvariantRule>>;

/**
 * Asserts that the current control state satisfies the invariants for the given stage.
 * Uses the canonical StageInvariantRule (require/forbid only; no validate callback).
 */
export function assertStageInvariants<St extends string>(
    ctx: TaskContext,
    stage: St,
    invariants: StageInvariantMap<St>
): void {
    const rule = invariants[stage];
    if (!rule) return;

    const controlVars = resolveControlVars(ctx);
    const snapshot = (controlVars ?? {}) as Record<string, unknown>;
    const iCtx = ctx as InternalTaskContext;
    const pendingSnapshot = iCtx.__activeLoopEnv?.pending;

    for (const key of rule.require ?? []) {
        if (snapshot[key] === undefined) {
            throwInvariantError('STAGE_REQUIRES_KEY', `[StageInvariant] ${String(stage)} requires control.${key}`, {
                type: 'stage_invariant',
                stage: String(stage),
                required: [key],
                pendingSnapshot,
            });
        }
    }

    for (const key of rule.forbid ?? []) {
        if (snapshot[key] !== undefined) {
            throwInvariantError('STAGE_FORBIDS_KEY', `[StageInvariant] ${String(stage)} forbids control.${key}`, {
                type: 'stage_invariant',
                stage: String(stage),
                forbidden: [key],
                pendingSnapshot,
            });
        }
    }
}
