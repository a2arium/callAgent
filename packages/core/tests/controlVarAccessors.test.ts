import {
    readControlVar,
    writeControlVar,
    deleteControlVar,
    resolveControlVars,
} from '../src/loop/controlVarAccessors.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { InternalTaskContext } from '../src/loop/internalContext.js';
import type { EnvironmentState } from '../src/loop/types.js';

function makeCtx(overrides: Partial<InternalTaskContext> = {}): TaskContext {
    return {
        progress: () => {},
        complete: () => {},
        ...overrides,
    } as TaskContext;
}

function makeEnv(controlVars?: Record<string, unknown>): EnvironmentState['pending'] {
    return {
        inputs: {},
        children: {},
        tools: {},
        groups: {},
        ...(controlVars ? { controlVars } : {}),
    };
}

describe('controlVarAccessors', () => {
    describe('readControlVar', () => {
        it('reads from controlVars on context', () => {
            const ctx = makeCtx({ controlVars: { stage: 'idle', token: 't1' } });
            expect(readControlVar(ctx, 'stage')).toBe('idle');
            expect(readControlVar(ctx, 'token')).toBe('t1');
        });

        it('falls back to __activeLoopEnv.pending.controlVars when ctx.controlVars is missing', () => {
            const pending = makeEnv({ stage: 'running' });
            const ctx = makeCtx({
                __activeLoopEnv: {
                    time: new Date().toISOString(),
                    turn: 0,
                    budget: { maxTurns: 10, latencyMs: 0 },
                    inbox: [],
                    pending,
                } as EnvironmentState,
            });
            expect(readControlVar(ctx, 'stage')).toBe('running');
        });

        it('returns undefined when key is missing', () => {
            const ctx = makeCtx({ controlVars: { stage: 'idle' } });
            expect(readControlVar(ctx, 'missing')).toBeUndefined();
        });

        it('returns undefined when controlVars is empty or absent', () => {
            const ctx = makeCtx();
            expect(readControlVar(ctx, 'stage')).toBeUndefined();
        });
    });

    describe('writeControlVar', () => {
        it('sets value in ctx.controlVars and syncs to __activeLoopEnv.pending.controlVars', () => {
            const pending = makeEnv();
            const ctx = makeCtx({
                controlVars: {},
                __activeLoopEnv: {
                    time: new Date().toISOString(),
                    turn: 0,
                    budget: { maxTurns: 10, latencyMs: 0 },
                    inbox: [],
                    pending,
                } as EnvironmentState,
            });
            writeControlVar(ctx, 'stage', 'running');
            expect((ctx as InternalTaskContext).controlVars?.stage).toBe('running');
            expect((ctx as InternalTaskContext).__activeLoopEnv?.pending?.controlVars?.stage).toBe('running');
        });

        it('updates value when env present and readControlVar returns it', () => {
            const pending = makeEnv({ token: 'old' });
            const ctx = makeCtx({
                controlVars: { token: 'old' },
                __activeLoopEnv: {
                    time: new Date().toISOString(),
                    turn: 0,
                    budget: { maxTurns: 10, latencyMs: 0 },
                    inbox: [],
                    pending,
                } as EnvironmentState,
            });
            writeControlVar(ctx, 'token', 'new');
            expect(readControlVar(ctx, 'token')).toBe('new');
        });
    });

    describe('deleteControlVar', () => {
        it('removes value from ctx.controlVars', () => {
            const ctx = makeCtx({ controlVars: { stage: 'idle' } });
            deleteControlVar(ctx, 'stage');
            expect(readControlVar(ctx, 'stage')).toBeUndefined();
        });

        it('removes value from both ctx and env.pending.controlVars when env present', () => {
            const pending = makeEnv({ stage: 'running' });
            const ctx = makeCtx({
                controlVars: { stage: 'running' },
                __activeLoopEnv: {
                    time: new Date().toISOString(),
                    turn: 0,
                    budget: { maxTurns: 10, latencyMs: 0 },
                    inbox: [],
                    pending,
                } as EnvironmentState,
            });
            deleteControlVar(ctx, 'stage');
            expect((ctx as InternalTaskContext).controlVars?.stage).toBeUndefined();
            expect((ctx as InternalTaskContext).__activeLoopEnv?.pending?.controlVars?.stage).toBeUndefined();
        });
    });

    describe('resolveControlVars', () => {
        it('returns ctx.controlVars when present', () => {
            const cv = { stage: 'idle' };
            const ctx = makeCtx({ controlVars: cv });
            expect(resolveControlVars(ctx)).toBe(cv);
        });

        it('returns env.pending.controlVars when ctx.controlVars is absent', () => {
            const pending = makeEnv({ stage: 'running' });
            const ctx = makeCtx({
                __activeLoopEnv: {
                    time: new Date().toISOString(),
                    turn: 0,
                    budget: { maxTurns: 10, latencyMs: 0 },
                    inbox: [],
                    pending,
                } as EnvironmentState,
                controlVars: undefined,
            });
            const resolved = resolveControlVars(ctx);
            expect(resolved).toEqual({ stage: 'running' });
        });

        it('returns undefined when neither source has controlVars', () => {
            const ctx = makeCtx();
            expect(resolveControlVars(ctx)).toBeUndefined();
        });
    });
});
