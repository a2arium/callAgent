import type { TaskContext } from '../shared/types/index.js';
import type { InternalTaskContext } from './internalContext.js';
import { PathUtils } from '../orchestration/utils/PathUtils.js';

function getEnvPending(ctx: TaskContext): Record<string, unknown> & { controlVars?: Record<string, unknown> } | undefined {
    const iCtx = ctx as InternalTaskContext;
    return iCtx.__activeLoopEnv?.pending as (Record<string, unknown> & { controlVars?: Record<string, unknown> }) | undefined;
}

/**
 * Resolve the effective controlVars object (ctx.controlVars or env.pending.controlVars).
 * Used by stage facade and invariant checks.
 */
export function resolveControlVars(ctx: TaskContext): Record<string, unknown> | undefined {
    const iCtx = ctx as InternalTaskContext;
    const fromCtx = iCtx.controlVars;
    const fromEnv = getEnvPending(ctx)?.controlVars;
    if (fromCtx != null && typeof fromCtx === 'object' && !Array.isArray(fromCtx)) {
        return fromCtx as Record<string, unknown>;
    }
    if (fromEnv != null && typeof fromEnv === 'object') {
        return fromEnv;
    }
    return undefined;
}

/**
 * Read a value at a control path (e.g. 'stage' or 'fetch.token').
 */
export function readControlVar(ctx: TaskContext, path: string): unknown {
    const controlVars = resolveControlVars(ctx);
    if (!controlVars || !path) return undefined;
    return PathUtils.getPath(controlVars, path);
}

/**
 * Write a value at a control path. Updates both ctx.controlVars and env.pending.controlVars when present.
 */
export function writeControlVar(ctx: TaskContext, path: string, value: unknown): void {
    if (!path) return;
    const iCtx = ctx as InternalTaskContext;
    const nextCtx = PathUtils.setPathImmutable(iCtx.controlVars, path, value);
    iCtx.controlVars = nextCtx;

    const env = iCtx.__activeLoopEnv;
    if (env) {
        const prev = env.pending ?? { inputs: {}, children: {}, tools: {}, groups: {} };
        env.pending = {
            ...prev,
            controlVars: PathUtils.setPathImmutable(prev.controlVars, path, value) as Record<string, unknown>,
        };
    }
}

/**
 * Remove a value at a control path.
 */
export function deleteControlVar(ctx: TaskContext, path: string): void {
    if (!path) return;
    const iCtx = ctx as InternalTaskContext;
    iCtx.controlVars = PathUtils.deletePathImmutable(iCtx.controlVars, path);

    const env = iCtx.__activeLoopEnv;
    const pending = getEnvPending(ctx);
    if (env && pending?.controlVars) {
        env.pending = {
            ...env.pending,
            controlVars: PathUtils.deletePathImmutable(pending.controlVars, path) as Record<string, unknown>,
        };
    }
}
