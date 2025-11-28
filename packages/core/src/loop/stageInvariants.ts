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

    const controlVars = (ctx as any).controlVars
        || (ctx as any).__activeLoopEnv?.pending?.controlVars
        || (ctx as any).env?.control?.pendingSnapshot?.controlVars;
    const hasVar = (key: string): boolean => {
        if (controlVars) {
            if (typeof (controlVars as any).has === 'function') return (controlVars as any).has(key);
            if (Object.prototype.hasOwnProperty.call(controlVars, key)) return true;
        }
        const memoryVars = (ctx.M as any)?.memory?.vars;
        return memoryVars ? Object.prototype.hasOwnProperty.call(memoryVars, key) : false;
    };

    if (Array.isArray(inv.required)) {
        for (const key of inv.required) {
            if (!hasVar(key)) {
                throw new Error(`[StageInvariant] ${String(stage)} requires control.${key}`);
            }
        }
    }

    if (Array.isArray(inv.forbidden)) {
        for (const key of inv.forbidden) {
            if (hasVar(key)) {
                throw new Error(`[StageInvariant] ${String(stage)} forbids control.${key}`);
            }
        }
    }

    if (typeof inv.validate === 'function') {
        inv.validate(ctx);
    }
}

