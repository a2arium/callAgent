import type { TaskContext } from '../shared/types/index.js';
import { throwInvariantError } from '../utils/invariantError.js';
import type { EnvironmentState } from './types.js';
import type { MentalState } from './types.js';

export type StageInvariant = {
    required?: string[];
    forbidden?: string[];
    validate?: (ctx: TaskContext) => void;
};

export type StageInvariants<TStage extends string> = Record<TStage, StageInvariant>;

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

export function assertStageInvariants<TStage extends string>(
    ctx: TaskContext,
    stage: TStage,
    invariants: StageInvariants<TStage>
): void {
    const inv = invariants[stage];
    if (!inv) return;

    const iCtx = ctx as InternalTaskContext;
    const controlVars = iCtx.controlVars
        || iCtx.__activeLoopEnv?.pending?.controlVars
        || iCtx.env?.control?.pendingSnapshot?.controlVars;

    const hasVar = (key: string): boolean => {
        if (!controlVars) return false;
        if (typeof (controlVars as Record<string, unknown>).has === 'function') return (controlVars as { has: (k: string) => boolean }).has(key);
        return Object.prototype.hasOwnProperty.call(controlVars, key);
    };

    const pendingSnapshot = iCtx.__activeLoopEnv?.pending;

    if (Array.isArray(inv.required)) {
        for (const key of inv.required) {
            if (!hasVar(key)) {
                throwInvariantError(
                    'STAGE_REQUIRES_KEY',
                    `[StageInvariant] ${String(stage)} requires control.${key}`,
                    {
                        type: 'stage_invariant',
                        stage: String(stage),
                        required: [key],
                        pendingSnapshot
                    }
                );
            }
        }
    }

    if (Array.isArray(inv.forbidden)) {
        for (const key of inv.forbidden) {
            if (hasVar(key)) {
                throwInvariantError(
                    'STAGE_FORBIDS_KEY',
                    `[StageInvariant] ${String(stage)} forbids control.${key}`,
                    {
                        type: 'stage_invariant',
                        stage: String(stage),
                        forbidden: [key],
                        pendingSnapshot
                    }
                );
            }
        }
    }

    if (typeof inv.validate === 'function') {
        inv.validate(ctx);
    }
}


