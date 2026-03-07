import { type TaskContext } from '../../shared/types/index.js';
import { PathUtils } from './PathUtils.js';

export class ControlVars {
    /**
     * Sync a specific key/value into the active loop environment if present.
     * This allows control variables (like token, stage) to be accessible immediately in the loop logic.
     * Replaces the legacy VarsSync utility for APLRET-compliant control plane storage.
     */
    static syncIntoActiveLoop(ctx: TaskContext, path: string, value: unknown): void {
        if (!path) return;
        const env = (ctx as any).__activeLoopEnv;
        if (!env) return;
        env.pending = env.pending || { inputs: {}, children: {}, tools: {}, groups: {} };
        (env.pending as any).controlVars = PathUtils.setPathImmutable((env.pending as any).controlVars, path, value);
        // Also sync to ctx.controlVars if it exists
        if ((ctx as any).controlVars) {
            (ctx as any).controlVars = PathUtils.setPathImmutable((ctx as any).controlVars, path, value);
        }
    }
}
