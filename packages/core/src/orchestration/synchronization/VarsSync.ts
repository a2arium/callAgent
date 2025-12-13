
import { type TaskContext } from '../../shared/types/index.js';
import { logger } from '@a2arium/callagent-utils';
import { PathUtils } from '../utils/PathUtils.js';

const log = logger.createLogger({ prefix: 'VarsSync' });

export class VarsSync {
    /**
     * Initializes the context variables facade for accessing and modifying working memory.
     * This creates a proxy that allows array-like access to variables.
     */
    static createVarsProxy(
        initialVars: Record<string, unknown> | Map<string, unknown>,
        onUpdate: (key: string, value: unknown) => void,
        onDelete: (key: string) => void
    ): any {
        const cache = initialVars instanceof Map ? initialVars : new Map<string, unknown>(Object.entries(initialVars));

        return {
            get: <T = unknown>(key: string) => cache.get(key) as T | undefined,
            set: (key: string, value: unknown) => {
                cache.set(key, value);
                onUpdate(key, value);
            },
            merge: (patch: Record<string, unknown>) => {
                Object.entries(patch).forEach(([k, v]) => {
                    cache.set(k, v);
                    onUpdate(k, v);
                });
            },
            update: <T = unknown>(key: string, fn: (prev: T | undefined) => T) => {
                const newVal = fn(cache.get(key) as T | undefined);
                cache.set(key, newVal);
                onUpdate(key, newVal);
            },
            delete: (key: string) => {
                cache.delete(key);
                onDelete(key);
            },
            keys: () => Array.from(cache.keys()),
            // Add custom iterators if needed to mock Map behavior fully
        };
    }

    /**
     * Synchronizes variables from the context cache into the mental state (M).
     * This ensures that changes made to ctx.vars are reflected in the snapshot's mental state.
     * Supports multiple targets for backward compatibility.
     */
    static assignVarsIntoMental(
        ctx: TaskContext,
        varCache: Map<string, unknown>,
        additionalTargets: unknown[] = []
    ): void {
        const varsObject = Object.fromEntries(varCache) as Record<string, unknown>;

        // Find all valid mental state targets
        const candidates: unknown[] = [
            (ctx as any).__mental,
            (ctx as any).M, // Legacy support
            ...additionalTargets
        ];

        const validTargets: { target: Record<string, unknown>, memory: Record<string, unknown>, existing: Record<string, unknown> }[] = [];

        for (const mental of candidates) {
            if (!mental || typeof mental !== 'object') continue;
            const target = mental as Record<string, unknown>;
            let memory = target.memory;

            if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
                memory = {};
                target.memory = memory as Record<string, unknown>;
            }

            const existing = ((memory as Record<string, unknown>).vars ?? {}) as Record<string, unknown>;
            validTargets.push({ target, memory: memory as Record<string, unknown>, existing });
        }

        // Merge vars
        const mergedVars: Record<string, unknown> = {};
        for (const { existing } of validTargets) {
            Object.assign(mergedVars, existing);
        }
        Object.assign(mergedVars, varsObject);

        // Update all targets with merged result
        for (const { target, memory } of validTargets) {
            (memory as Record<string, unknown>).vars = { ...mergedVars };
            target.vars = { ...mergedVars };
        }

        log.debug('✅ Synced vars to mental state', {
            count: varCache.size,
            targets: validTargets.length
        });
    }

    /**
     * Creates a simple vars facade directly on the context object.
     * Used in resumeInput/handleChildCompleted scenarios where full proxy might be overkill or different.
     */
    static ensureVarsFacade(
        ctx: TaskContext,
        varsState: Record<string, unknown>
    ): void {
        (ctx as any).vars = {
            get: <T = unknown>(key: string) => varsState[key] as T | undefined,
            set: (key: string, value: unknown) => {
                varsState[key] = value;
            },
            merge: (patch: Record<string, unknown>) => {
                Object.assign(varsState, patch);
            },
            update: (key: string, fn: (prev: unknown) => unknown) => {
                varsState[key] = fn(varsState[key]);
            },
            delete: (key: string) => { delete varsState[key]; },
            keys: () => Object.keys(varsState),
            has: (key: string) => Object.prototype.hasOwnProperty.call(varsState, key)
        } as TaskContext['vars'];
    }

    /**
    * Sync a specific key/value into the active loop environment if present.
    * This allows control variables (like token, stage) to be accessible immediately in the loop logic.
    */
    static syncControlVarIntoActiveLoop(ctx: TaskContext, path: string, value: unknown): void {
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
