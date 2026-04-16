import type { TaskContext } from '../shared/types/index.js';
import type {
    GoalHierarchy,
    GoalId,
    GoalNode,
    GoalStatus,
    GoalType,
    MentalState,
    TaskContextGoalAddInput,
    TaskContextGoalUpdatePatch,
    TaskContextGoalsReadFilter,
} from './types.js';
import { throwInvariantError } from '../utils/invariantError.js';

function nowIso(): string { return new Date().toISOString(); }

/**
 * Internal interface for context access in goals module
 */
interface InternalContext extends TaskContext {
    __mental: MentalState;
}

function ensureMental(ctx: TaskContext): MentalState { 
    return (ctx as unknown as InternalContext).__mental; 
}

function validatePriority(p?: number): number {
    const v = typeof p === 'number' ? p : 1;
    if (v < 0 || v > 1) {
        throwInvariantError(
            'GOAL_PRIORITY_OUT_OF_RANGE',
            `Goal priority ${v} is out of range [0, 1]`,
            { type: 'goal_invariant', reason: 'priority_out_of_range' }
        );
    }
    return v;
}
// ... rest of private helpers ...
function upsertNode(h: GoalHierarchy, node: GoalNode, parentId?: GoalId, order?: number): void {
    h.nodes[node.id] = node;
    if (parentId) {
        // parent-child relation is implicit via node.parentId
    } else {
        // Root list maintenance
        const existingIdx = h.roots.indexOf(node.id);
        if (existingIdx === -1) h.roots.push(node.id);
        if (typeof order === 'number') {
            // reorder within roots
            const from = h.roots.indexOf(node.id);
            if (from !== -1) {
                h.roots.splice(from, 1);
                h.roots.splice(Math.max(0, Math.min(order, h.roots.length)), 0, node.id);
            }
        }
    }
}

export async function addGoal(ctx: TaskContext, input: TaskContextGoalAddInput): Promise<GoalId> {
    const M = ensureMental(ctx);
    const h = M.goalState.hierarchy;
    const id = input.id || `g_${Math.random().toString(36).slice(2)}`;
    const ts = nowIso();
    const node: GoalNode = {
        id,
        title: input.title,
        type: input.type || 'short',
        priority: validatePriority(input.priority),
        status: 'active',
        parentId: input.parentId,
        order: undefined,
        context: input.context,
        createdAt: ts,
        updatedAt: ts
    };
    upsertNode(h, node, input.parentId);
    return id;
}

export async function updateGoal(ctx: TaskContext, id: GoalId, patch: TaskContextGoalUpdatePatch): Promise<void> {
    const M = ensureMental(ctx);
    const h = M.goalState.hierarchy;
    const existing = h.nodes[id];
    if (!existing) {
        throwInvariantError(
            'GOAL_NOT_FOUND',
            `Goal ${id} not found`,
            { type: 'goal_invariant', goalId: id, reason: 'goal_not_found' }
        );
    }
    const next: GoalNode = {
        ...existing,
        ...patch,
        priority: validatePriority(patch.priority ?? existing.priority),
        updatedAt: nowIso()
    };
    h.nodes[id] = next;
}

export async function moveGoal(
    ctx: TaskContext,
    id: GoalId,
    parentId?: GoalId,
    order?: number
): Promise<void> {
    const M = ensureMental(ctx);
    const h = M.goalState.hierarchy;
    const existing = h.nodes[id];
    if (!existing) {
        throwInvariantError(
            'GOAL_NOT_FOUND',
            `Goal ${id} not found`,
            { type: 'goal_invariant', goalId: id, reason: 'goal_not_found' }
        );
    }
    const next = { ...existing, parentId, updatedAt: nowIso() } as GoalNode;
    h.nodes[id] = next;
    // root ordering maintenance when moving to/from root
    if (!parentId) {
        const idx = h.roots.indexOf(id);
        if (idx === -1) h.roots.push(id);
        if (typeof order === 'number') {
            const from = h.roots.indexOf(id);
            if (from !== -1) {
                h.roots.splice(from, 1);
                h.roots.splice(Math.max(0, Math.min(order, h.roots.length)), 0, id);
            }
        }
    } else {
        // if previously root, remove from roots
        const i = h.roots.indexOf(id);
        if (i !== -1) h.roots.splice(i, 1);
    }
}

export async function completeGoal(
    ctx: TaskContext,
    id: GoalId,
    opts?: { cascadeChildren?: boolean; requireNoActiveChildren?: boolean }
): Promise<void> {
    const M = ensureMental(ctx);
    const h = M.goalState.hierarchy;
    const existing = h.nodes[id];
    if (!existing) {
        throwInvariantError(
            'GOAL_NOT_FOUND',
            `Goal ${id} not found`,
            { type: 'goal_invariant', goalId: id, reason: 'goal_not_found' }
        );
    }
    if (opts?.requireNoActiveChildren) {
        const hasActiveChild = Object.values(h.nodes).some(n => n.parentId === id && n.status === 'active');
        if (hasActiveChild) {
            throwInvariantError(
                'GOAL_HAS_ACTIVE_CHILDREN',
                `Goal ${id} has active children`,
                { type: 'goal_invariant', goalId: id, reason: 'goal_has_active_children' }
            );
        }
    }
    h.nodes[id] = { ...existing, status: 'done', completedAt: nowIso(), updatedAt: nowIso() };
    if (opts?.cascadeChildren) {
        for (const n of Object.values(h.nodes)) {
            if (n.parentId === id && n.status !== 'done') {
                h.nodes[n.id] = { ...n, status: 'done', completedAt: nowIso(), updatedAt: nowIso() };
            }
        }
    }
}

export async function failGoal(ctx: TaskContext, id: GoalId): Promise<void> {
    const M = ensureMental(ctx);
    const h = M.goalState.hierarchy;
    const existing = h.nodes[id];
    if (!existing) {
        throwInvariantError(
            'GOAL_NOT_FOUND',
            `Goal ${id} not found`,
            { type: 'goal_invariant', goalId: id, reason: 'goal_not_found' }
        );
    }
    h.nodes[id] = { ...existing, status: 'failed', updatedAt: nowIso() };
}

export async function listGoals(ctx: TaskContext, filter?: TaskContextGoalsReadFilter): Promise<GoalNode[]> {
    const M = ensureMental(ctx);
    const h = M.goalState.hierarchy;
    let nodes = Object.values(h.nodes);
    if (filter?.status) nodes = nodes.filter(n => n.status === filter.status);
    if (typeof filter?.parentId !== 'undefined') nodes = nodes.filter(n => n.parentId === filter.parentId);
    if (filter?.type) nodes = nodes.filter(n => n.type === filter.type);
    return nodes;
}



