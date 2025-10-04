import type { TaskContext } from '../shared/types/index.js';
import type { MentalState } from './types.js';
export declare function initialM(ctx: TaskContext): MentalState;
export declare function touchGoalTimestamps(node: {
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
}, completed?: boolean): void;
