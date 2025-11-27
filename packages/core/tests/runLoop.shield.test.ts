import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import { normalizeObservationInbox } from '../src/loop/types.js';

describe('runLoop shield safety branches', () => {
    const baseEnv = () => ({
        time: new Date().toISOString(),
        sessionId: 'shield-session',
        turn: 1,
        budget: { maxTurns: 1, latencyMs: 0 },
        pending: { inputs: {}, children: {}, tools: {}, groups: {} },
        inbox: normalizeObservationInbox(undefined),
        lastExec: undefined
    });

    it('defers execution when PII patterns are detected', async () => {
        const ctx: any = { task: { id: 'task-shield', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        M.hitl = 'advise';
        M.safety = { piiPatterns: ['secret'] };

        let capturedAction: any;
        const modules = {
            attention: () => ({}),
            perception: () => ({}),
            learning: (prev: any) => prev,
            policy: () => ({ kind: 'tool', name: 'send', args: { message: 'contains secret data' } }),
            execution: jest.fn(async (action: any) => {
                capturedAction = action;
                return { action: { kind: 'ask_user', token: 'pii-token' }, result: { status: 'ok', data: action } };
            }),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, baseEnv() as any, modules as any, { maxTurns: 1 });

        expect(capturedAction?.kind).toBe('ask_user');
        expect(String(capturedAction?.prompt || '')).toContain('PII');
        expect(M.lastAdvise).toEqual({ flagged: 'pii' });
        expect(result.outcome.kind).toBe('await_input');
        expect((result.outcome as any).token).toBe('pii-token');
    });

    it('blocks expensive actions when cost exceeds configured limit', async () => {
        const ctx: any = { task: { id: 'task-cost', input: {} }, reply: jest.fn() };
        const M: any = initialM(ctx);
        M.hitl = 'advise';
        M.safety = { costLimit: 5 };

        let capturedAction: any;
        const modules = {
            attention: () => ({}),
            perception: () => ({}),
            learning: (prev: any) => prev,
            policy: () => ({ kind: 'tool', name: 'expensive-tool', args: { cost: 10 } }),
            execution: jest.fn(async (action: any) => {
                capturedAction = action;
                return { action: { kind: 'ask_user', token: 'cost-token' }, result: { status: 'ok', data: action } };
            }),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, baseEnv() as any, modules as any, { maxTurns: 1 });

        expect(capturedAction?.kind).toBe('ask_user');
        expect(String(capturedAction?.prompt || '')).toContain('cost');
        expect(M.lastAdvise).toEqual({ blocked: 'cost', cost: 10, limit: 5 });
        expect(result.outcome.kind).toBe('await_input');
        expect((result.outcome as any).token).toBe('cost-token');
    });
});
