import type { TaskContext } from '../shared/types/index.js';
export type StageInvariant = {
    required?: string[];
    forbidden?: string[];
    validate?: (ctx: TaskContext) => void;
};
export type StageInvariants<TStage extends string> = Record<TStage, StageInvariant>;
export declare function assertStageInvariants<TStage extends string>(ctx: TaskContext, stage: TStage, invariants: StageInvariants<TStage>): void;
