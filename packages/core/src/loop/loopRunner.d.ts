import type { TaskContext } from '../shared/types/index.js';
import { type Modules, type TurnOutcome } from './oneTurn.js';
import type { EnvironmentState, MentalState } from './types.js';
type LoopRunnerOptions = {
    maxTurns?: number;
    latencyMs?: number;
};
export declare function runLoop(ctx: TaskContext, M: MentalState, env: EnvironmentState, modules: Partial<Modules>, opts?: LoopRunnerOptions): Promise<{
    M: MentalState;
    outcome: TurnOutcome;
    metrics?: {
        timings: Record<string, number>[];
        rewards: number[];
    };
}>;
export {};
