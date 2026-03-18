import { createStageFacade } from '../src/loop/stageHelpers.js';
import type { TaskContext } from '../src/shared/types/index.js';
import { InvariantError } from '../src/utils/errors.js';
import type { InternalTaskContext } from '../src/loop/internalContext.js';

const stages = ['idle', 'running', 'completed'] as const;
type TestStage = (typeof stages)[number];

function makeCtx(overrides: Partial<InternalTaskContext> = {}): TaskContext {
    return {
        progress: () => {},
        complete: () => {},
        ...overrides,
    } as TaskContext;
}

describe('createStageFacade', () => {
    it('creates a facade with required stages and returns get/set/is/assert/summary', () => {
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
        });
        expect(Stage.get).toBeDefined();
        expect(Stage.set).toBeDefined();
        expect(Stage.is).toBeDefined();
        expect(Stage.assert).toBeDefined();
        expect(Stage.summary).toBeDefined();
    });

    it('get() returns initial when no stage set', () => {
        const Stage = createStageFacade<TestStage>({ stages, initial: 'idle' });
        const ctx = makeCtx();
        expect(Stage.get(ctx)).toBe('idle');
    });

    it('get() returns current stage after set()', () => {
        const Stage = createStageFacade<TestStage>({ stages, initial: 'idle' });
        const ctx = makeCtx({ controlVars: {} });
        Stage.set(ctx, 'running');
        expect(Stage.get(ctx)).toBe('running');
    });

    it('set() returns StageTransitionResult', () => {
        const Stage = createStageFacade<TestStage>({ stages, initial: 'idle' });
        const ctx = makeCtx({ controlVars: {} });
        const result = Stage.set(ctx, 'running');
        expect(result).toEqual({
            from: 'idle',
            to: 'running',
            autoMarksApplied: [],
            invariantChecks: [],
        });
    });

    it('is() returns true when current stage matches', () => {
        const Stage = createStageFacade<TestStage>({ stages, initial: 'idle' });
        const ctx = makeCtx({ controlVars: {} });
        expect(Stage.is(ctx, 'idle')).toBe(true);
        Stage.set(ctx, 'running');
        expect(Stage.is(ctx, 'running')).toBe(true);
        expect(Stage.is(ctx, 'idle')).toBe(false);
    });

    it('summary() returns normalized shape', () => {
        const Stage = createStageFacade<TestStage>({ stages, initial: 'idle' });
        const ctx = makeCtx({ controlVars: {} });
        const s = Stage.summary(ctx);
        expect(s).toMatchObject({
            current: 'idle',
            hasPendingInput: false,
            hasPendingTool: false,
            hasPendingChild: false,
            markCount: 0,
        });
    });

    it('applies autoMarks on set()', () => {
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
            autoMarks: {
                completed: { done: true },
            },
        });
        const ctx = makeCtx({ controlVars: {} });
        Stage.set(ctx, 'completed');
        expect((ctx as InternalTaskContext).controlVars?.stage).toBe('completed');
        expect((ctx as InternalTaskContext).controlVars?.done).toBe(true);
    });

    it('calls onEnter with StageEnterContext (progress/complete only)', () => {
        let progressCalled = false;
        let completeCalled = false;
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
            onEnter: {
                running: (ctx) => {
                    expect(typeof ctx.progress).toBe('function');
                    expect(typeof ctx.complete).toBe('function');
                    expect('reply' in ctx).toBe(false);
                    ctx.progress(50, 'half');
                    progressCalled = true;
                    ctx.complete(100, 'done');
                    completeCalled = true;
                },
            },
        });
        const ctx = makeCtx({ controlVars: {}, progress: () => {}, complete: () => {} });
        Stage.set(ctx, 'running');
        expect(progressCalled).toBe(true);
        expect(completeCalled).toBe(true);
    });

    it('throws InvariantError when required key is missing and does not commit', () => {
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
            invariants: {
                completed: { require: ['token'] },
            },
        });
        const ctx = makeCtx({ controlVars: {} });
        expect(() => Stage.set(ctx, 'completed')).toThrow(InvariantError);
        expect(Stage.get(ctx)).toBe('idle');
    });

    it('throws InvariantError when forbidden key is present', () => {
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
            invariants: {
                idle: { forbid: ['dirty'] },
            },
        });
        const ctx = makeCtx({ controlVars: { dirty: true } });
        expect(() => Stage.set(ctx, 'idle')).toThrow(InvariantError);
    });

    it('assert() throws when invariant fails', () => {
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
            invariants: {
                idle: { require: ['ready'] },
            },
        });
        const ctx = makeCtx({ controlVars: {} });
        expect(() => Stage.assert(ctx, 'idle')).toThrow(InvariantError);
    });

    it('writes __stageTrace on set()', () => {
        const Stage = createStageFacade<TestStage>({ stages, initial: 'idle' });
        const ctx = makeCtx({ controlVars: {} }) as InternalTaskContext;
        Stage.set(ctx, 'running');
        expect(ctx.__stageTrace).toBeDefined();
        expect(ctx.__stageTrace?.stageBefore).toBe('idle');
        expect(ctx.__stageTrace?.stageAfter).toBe('running');
        expect(ctx.__stageTrace?.stageTransition).toEqual({ from: 'idle', to: 'running' });
    });
});
