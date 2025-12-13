
import { type TaskContext } from '../../shared/types/index.js';
import { PathUtils } from './PathUtils.js';
import { type TaskEntity, type CleanChildResult } from '../types.js';

export class TaskStateUtils {

    /**
     * Helper function to detect if a result is a TaskEntity (wrapped child task result)
     */
    static isTaskEntityResult(result: unknown): result is TaskEntity {
        return result !== null && result !== undefined && typeof result === 'object' &&
            typeof (result as any).id === 'string' &&
            typeof (result as any).status === 'object' &&
            (result as any).status !== null;
    }

    /**
     * Extract clean result from potentially wrapped TaskEntity
     */
    static extractCleanChildResult(result: unknown): CleanChildResult {
        if (!TaskStateUtils.isTaskEntityResult(result)) {
            return { result };
        }

        const taskEntity = result as TaskEntity;
        return {
            childTaskId: taskEntity.id,
            result: taskEntity.status?.metadata?.result ?? result,
            executionMetadata: {
                timings: taskEntity.status?.metadata?.timings,
                rewards: taskEntity.status?.metadata?.rewards,
                state: taskEntity.status?.state,
                timestamp: taskEntity.status?.timestamp
            }
        };
    }

    static applyControlVarToSnapshot(snapshot: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
        const next = { ...snapshot } as any;
        next.pending = { ...(next.pending || {}) };
        next.pending.controlVars = PathUtils.setPathImmutable(next.pending.controlVars, path, value);
        return next;
    }


    static removeControlVarFromSnapshot(snapshot: Record<string, unknown>, path: string): Record<string, unknown> {
        const next = { ...snapshot } as any;
        next.pending = { ...(next.pending || {}) };
        next.pending.controlVars = PathUtils.deletePathImmutable(next.pending.controlVars, path);
        return next;
    }

    static syncControlVarIntoActiveLoop(ctx: TaskContext, path: string, value: unknown): void {
        if (!path) return;
        const env = (ctx as any).__activeLoopEnv;
        if (!env) return;
        env.pending = env.pending || { inputs: {}, children: {}, tools: {}, groups: {} };
        (env.pending as any).controlVars = PathUtils.setPathImmutable((env.pending as any).controlVars, path, value);
        (ctx as any).controlVars = PathUtils.setPathImmutable((ctx as any).controlVars, path, value);
    }

    static clearControlVarInActiveLoop(ctx: TaskContext, path: string): void {
        if (!path) return;
        const env = (ctx as any).__activeLoopEnv;
        if (!env) return;
        if ((env.pending as any)?.controlVars) {
            (env.pending as any).controlVars = PathUtils.deletePathImmutable((env.pending as any).controlVars, path);
        }
        if ((ctx as any).controlVars) {
            (ctx as any).controlVars = PathUtils.deletePathImmutable((ctx as any).controlVars, path);
        }
    }
}
