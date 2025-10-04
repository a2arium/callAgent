import type { TaskContext } from '../shared/types/index.js';
import type { GoalId, GoalNode, GoalStatus, GoalType } from './types.js';
export declare function addGoal(ctx: TaskContext, input: {
    id?: GoalId;
    title: string;
    type?: GoalType;
    priority?: number;
    parentId?: GoalId;
    context?: GoalNode['context'];
}): Promise<GoalId>;
export declare function updateGoal(ctx: TaskContext, id: GoalId, patch: Partial<Omit<GoalNode, 'id' | 'createdAt'>>): Promise<void>;
export declare function moveGoal(ctx: TaskContext, id: GoalId, parentId?: GoalId, order?: number): Promise<void>;
export declare function completeGoal(ctx: TaskContext, id: GoalId, opts?: {
    cascadeChildren?: boolean;
    requireNoActiveChildren?: boolean;
}): Promise<void>;
export declare function failGoal(ctx: TaskContext, id: GoalId): Promise<void>;
export declare function listGoals(ctx: TaskContext, filter?: {
    status?: GoalStatus;
    parentId?: GoalId;
    type?: GoalType;
}): Promise<GoalNode[]>;
