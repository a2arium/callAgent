import type { TaskContext } from '../shared/types/index.js';

export type StageInvariant = {
    required?: string[];
    forbidden?: string[];
    validate?: (ctx: TaskContext) => void;
};

export type StageInvariants<TStage extends string> = Record<TStage, StageInvariant>;

export function assertStageInvariants<TStage extends string>(
    ctx: TaskContext,
    stage: TStage,
    invariants: StageInvariants<TStage>
): void {
    const inv = invariants[stage];
    if (!inv) return;

    if (Array.isArray(inv.required)) {
        for (const key of inv.required) {
            if (!ctx.vars.has(key)) {
                throw new Error(`[StageInvariant] ${String(stage)} requires ctx.vars.${key}`);
            }
        }
    }

    if (Array.isArray(inv.forbidden)) {
        for (const key of inv.forbidden) {
            if (ctx.vars.has(key)) {
                throw new Error(`[StageInvariant] ${String(stage)} forbids ctx.vars.${key}`);
            }
        }
    }

    if (typeof inv.validate === 'function') {
        inv.validate(ctx);
    }
}


