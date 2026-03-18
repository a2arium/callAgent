import { assertStageInvariants } from '../src/loop/stageInvariants.js';
import type { TaskContext } from '../src/shared/types/index.js';
import { InvariantError } from '../src/utils/errors.js';
import type { InternalTaskContext } from '../src/loop/internalContext.js';
import type { StageInvariantRule } from '../src/types/stageFacade.js';

type TestStage = 'idle' | 'running' | 'completed';

function makeCtx(overrides: Partial<InternalTaskContext> = {}): TaskContext {
    return {
        progress: () => {},
        complete: () => {},
        ...overrides,
    } as TaskContext;
}

describe('assertStageInvariants', () => {
    it('passes when all required keys are present in controlVars', () => {
        const ctx = makeCtx({ controlVars: { token: 't1', ready: true } });
        const invariants: Partial<Record<TestStage, StageInvariantRule>> = {
            running: { require: ['token', 'ready'] },
        };
        expect(() => assertStageInvariants(ctx, 'running', invariants)).not.toThrow();
    });

    it('throws InvariantError with correct code and detail for missing required key', () => {
        const ctx = makeCtx({ controlVars: {} });
        const invariants: Partial<Record<TestStage, StageInvariantRule>> = {
            running: { require: ['token'] },
        };
        expect(() => assertStageInvariants(ctx, 'running', invariants)).toThrow(InvariantError);
        try {
            assertStageInvariants(ctx, 'running', invariants);
        } catch (e) {
            expect(e).toBeInstanceOf(InvariantError);
            const inv = e as InvariantError;
            expect(inv.code).toBe('STAGE_REQUIRES_KEY');
            expect(inv.detail).toMatchObject({
                type: 'stage_invariant',
                stage: 'running',
                required: ['token'],
            });
            expect(inv.detail).toHaveProperty('pendingSnapshot');
        }
    });

    it('throws InvariantError with correct code and detail for present forbidden key', () => {
        const ctx = makeCtx({ controlVars: { dirty: true } });
        const invariants: Partial<Record<TestStage, StageInvariantRule>> = {
            idle: { forbid: ['dirty'] },
        };
        expect(() => assertStageInvariants(ctx, 'idle', invariants)).toThrow(InvariantError);
        try {
            assertStageInvariants(ctx, 'idle', invariants);
        } catch (e) {
            expect(e).toBeInstanceOf(InvariantError);
            const inv = e as InvariantError;
            expect(inv.code).toBe('STAGE_FORBIDS_KEY');
            expect(inv.detail).toMatchObject({
                type: 'stage_invariant',
                stage: 'idle',
                forbidden: ['dirty'],
            });
        }
    });

    it('handles stages with no invariants (no-op)', () => {
        const ctx = makeCtx({ controlVars: {} });
        const invariants: Partial<Record<TestStage, StageInvariantRule>> = {};
        expect(() => assertStageInvariants(ctx, 'idle', invariants)).not.toThrow();
    });

    it('handles empty invariant rules (no-op)', () => {
        const ctx = makeCtx({ controlVars: {} });
        const invariants: Partial<Record<TestStage, StageInvariantRule>> = {
            idle: {},
        };
        expect(() => assertStageInvariants(ctx, 'idle', invariants)).not.toThrow();
    });

    it('uses __activeLoopEnv.pending when controlVars not on ctx', () => {
        const pending = { inputs: {}, children: {}, tools: {}, groups: {}, controlVars: { token: 'x' } };
        const ctx = makeCtx({
            __activeLoopEnv: {
                time: new Date().toISOString(),
                turn: 0,
                budget: { maxTurns: 10, latencyMs: 0 },
                inbox: [],
                pending,
            } as InternalTaskContext['__activeLoopEnv'],
        });
        const invariants: Partial<Record<TestStage, StageInvariantRule>> = {
            running: { require: ['token'] },
        };
        expect(() => assertStageInvariants(ctx, 'running', invariants)).not.toThrow();
    });
});
