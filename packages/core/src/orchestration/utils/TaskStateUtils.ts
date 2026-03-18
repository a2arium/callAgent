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

    static applyControlVarToSnapshot(
        snapshot: Record<string, unknown> & { pending?: { controlVars?: Record<string, unknown> } },
        path: string,
        value: unknown
    ): Record<string, unknown> {
        const pending = snapshot.pending ?? {};
        const controlVars = PathUtils.setPathImmutable(pending.controlVars, path, value) as Record<string, unknown>;
        return { ...snapshot, pending: { ...pending, controlVars } };
    }

    static removeControlVarFromSnapshot(
        snapshot: Record<string, unknown> & { pending?: { controlVars?: Record<string, unknown> } },
        path: string
    ): Record<string, unknown> {
        const pending = snapshot.pending ?? {};
        const controlVars = PathUtils.deletePathImmutable(pending.controlVars, path) as Record<string, unknown>;
        return { ...snapshot, pending: { ...pending, controlVars } };
    }
}
