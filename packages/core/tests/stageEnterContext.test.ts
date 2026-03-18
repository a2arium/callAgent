import { createStageFacade } from '../src/loop/stageHelpers.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { InternalTaskContext } from '../src/loop/internalContext.js';
import type { StageEnterContext } from '../src/types/stageFacade.js';

const stages = ['idle', 'running'] as const;
type TestStage = (typeof stages)[number];

function makeCtx(overrides: Partial<InternalTaskContext> = {}): TaskContext {
    return {
        progress: () => {},
        complete: () => {},
        ...overrides,
    } as TaskContext;
}

describe('StageEnterContext restriction', () => {
    it('onEnter callback receives only progress and complete methods', () => {
        let receivedCtx: StageEnterContext | undefined;
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
            onEnter: {
                running: (ctx) => {
                    receivedCtx = ctx;
                    expect(typeof ctx.progress).toBe('function');
                    expect(typeof ctx.complete).toBe('function');
                    expect(Object.keys(ctx)).toEqual(['progress', 'complete']);
                },
            },
        });
        const ctx = makeCtx({ controlVars: {} });
        Stage.set(ctx, 'running');
        expect(receivedCtx).toBeDefined();
        expect(receivedCtx!.progress).toBeDefined();
        expect(receivedCtx!.complete).toBeDefined();
    });

    it('onEnter callback does NOT receive reply, requestInput, sendTaskToAgent, requestTool, tools, llm', () => {
        let receivedCtx: StageEnterContext | undefined;
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
            onEnter: {
                running: (ctx) => {
                    receivedCtx = ctx;
                },
            },
        });
        const ctx = makeCtx({ controlVars: {} });
        Stage.set(ctx, 'running');
        expect(receivedCtx).toBeDefined();
        const c = receivedCtx as Record<string, unknown>;
        expect(c.reply).toBeUndefined();
        expect(c.requestInput).toBeUndefined();
        expect(c.sendTaskToAgent).toBeUndefined();
        expect(c.requestTool).toBeUndefined();
        expect(c.tools).toBeUndefined();
        expect(c.llm).toBeUndefined();
    });

    it('progress and complete are callable and forward to ctx', () => {
        const progressCalls: [number, string][] = [];
        const completeCalls: [number, string][] = [];
        const Stage = createStageFacade<TestStage>({
            stages,
            initial: 'idle',
            onEnter: {
                running: (ctx) => {
                    ctx.progress(50, 'half');
                    ctx.complete(100, 'done');
                },
            },
        });
        const ctx = makeCtx({
            controlVars: {},
            progress: (pct: number, msg: string) => progressCalls.push([pct, msg]),
            complete: (pct: number, msg: string) => completeCalls.push([pct, msg]),
        });
        Stage.set(ctx, 'running');
        expect(progressCalls).toEqual([[50, 'half']]);
        expect(completeCalls).toEqual([[100, 'done']]);
    });
});
