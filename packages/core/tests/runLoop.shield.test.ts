import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import { normalizeObservationInbox } from '../src/loop/types.js';
import { deriveConsentEffectKey, digestIntent } from '../src/loop/manifestConsent.js';

describe('runLoop shield safety branches', () => {
    const baseEnv = () => ({
        time: new Date().toISOString(),
        sessionId: 'shield-session',
        turn: 0,
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
            policy: () => ({ kind: 'call_tool', toolName: 'send', args: { message: 'contains secret data' } }),
            execution: jest.fn(async (action: any) => {
                capturedAction = action;
                return { action: { kind: 'prompt_user', token: 'pii-token' }, result: { status: 'ok', data: action } };
            }),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, baseEnv() as any, modules as any, { maxTurns: 1 });

        expect(capturedAction?.kind).toBe('prompt_user');
        expect(String(capturedAction?.prompt || '')).toContain('PII');
        expect(result.M.lastAdvise).toEqual({ flagged: 'pii' });
        expect(result.outcome.kind).toBe('await_input');
        expect((result.outcome as any).token).toBe('pii-token');
        expect(result.traces?.[0]?.conversation).toBeUndefined();
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
            policy: () => ({ kind: 'call_tool', toolName: 'expensive-tool', args: { cost: 10 } }),
            execution: jest.fn(async (action: any) => {
                capturedAction = action;
                return { action: { kind: 'prompt_user', token: 'cost-token' }, result: { status: 'ok', data: action } };
            }),
            extrinsicReward: () => 0,
            intrinsicReward: () => 0
        };

        const result = await runLoop(ctx, M, baseEnv() as any, modules as any, { maxTurns: 1 });

        expect(capturedAction?.kind).toBe('prompt_user');
        expect(String(capturedAction?.prompt || '')).toContain('cost');
        expect(result.M.lastAdvise).toEqual({ blocked: 'cost', cost: 10, limit: 5 });
        expect(result.outcome.kind).toBe('await_input');
        expect((result.outcome as any).token).toBe('cost-token');
        expect(result.traces?.[0]?.incomingMessages).toBeUndefined();
    });
});

describe('runLoop manifest consent obligation', () => {
    const intent = { kind: 'internal', intent: 'activate_bundle', data: { bundleId: 'b-1' } } as const;
    const env = () => ({
        time: new Date().toISOString(), sessionId: 'consent-task', turn: 0,
        budget: { maxTurns: 1, latencyMs: 0 },
        pending: { inputs: {}, children: {}, tools: {}, groups: {}, manifestConsents: {} },
        inbox: normalizeObservationInbox(undefined), lastExec: undefined,
    });

    it('defers a listed post-Shield intent without calling agent Execution', async () => {
        const execution = jest.fn(async () => ({ action: { kind: 'internal', done: true }, result: { status: 'ok' } }));
        const flushSnapshot = jest.fn(async () => undefined);
        const ctx: any = {
            task: { id: 'consent-task', input: {} }, tenantId: 'tenant-a', agentId: 'agent-a',
            reply: jest.fn(), flushSnapshot,
            requestInput: jest.fn(async () => ({ token: 'consent-token' })),
        };
        const result = await runLoop(ctx, initialM(ctx), env() as any, {
            policy: () => intent,
            shield: (_m: any, proposed: any) => ({ action: 'transform', intent: proposed }),
            execution,
        } as any, {
            maxTurns: 1, collectTraces: true,
            hitl: { requireConsentFor: { intents: ['activate_bundle'] }, consentTtlMs: 60_000 },
        });
        expect(execution).not.toHaveBeenCalled();
        expect(result.outcome).toEqual({ kind: 'await_input', token: 'consent-token' });
        expect(result.traces?.[0]?.manifestConsent).toMatchObject({
            action: 'defer', intentId: 'activate_bundle', receiptStatus: 'pending',
        });
        expect(flushSnapshot).toHaveBeenCalled();
    });

    it('reserves an approved exact intent and exposes a stable effect key only during Execution', async () => {
        const digest = digestIntent(intent as any);
        const receipt: any = {
            token: 'consent-token', taskId: 'consent-task', agentId: 'agent-a', tenantId: 'tenant-a',
            intentId: 'activate_bundle', intentDigest: digest, requestedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(), effectIdempotencyKey: '', status: 'approved',
        };
        receipt.effectIdempotencyKey = deriveConsentEffectKey(receipt);
        const state = env() as any;
        state.pending.manifestConsents[receipt.token] = receipt;
        const seenKeys: string[] = [];
        const ctx: any = {
            task: { id: 'consent-task', input: {} }, tenantId: 'tenant-a', agentId: 'agent-a',
            reply: jest.fn(), flushSnapshot: jest.fn(async () => undefined),
        };
        const result = await runLoop(ctx, initialM(ctx), state, {
            policy: () => intent,
            shield: (_m: any, proposed: any) => ({ action: 'pass', intent: proposed }),
            execution: jest.fn(async () => {
                seenKeys.push(ctx.effect.idempotencyKey);
                return { action: { kind: 'internal', done: true }, result: { status: 'ok' } };
            }),
            transition: () => ({ kind: 'complete', result: { ok: true } }),
        } as any, {
            maxTurns: 1, collectTraces: true,
            hitl: { requireConsentFor: { intents: ['activate_bundle'] } },
        });
        expect(seenKeys).toEqual([receipt.effectIdempotencyKey]);
        expect(receipt.status).toBe('consumed');
        expect(ctx.effect).toBeUndefined();
        expect(result.traces?.[0]?.manifestConsent).toMatchObject({ action: 'consume', receiptStatus: 'consumed' });
    });

    it('does not add a manifest prompt when the default level-based Shield already defers a tool', async () => {
        const ctx: any = {
            task: { id: 'tool-consent-task', input: {} }, tenantId: 'tenant-a', agentId: 'agent-a', reply: jest.fn(),
            requestInput: jest.fn(async () => ({ token: 'shield-token' })),
        };
        const execution = jest.fn(async () => ({
            action: { kind: 'prompt_user', token: 'shield-token' }, result: { status: 'ok' },
        }));
        const result = await runLoop(ctx, initialM(ctx), env() as any, {
            policy: () => ({ kind: 'call_tool', toolName: 'publish', args: {} }), execution,
        } as any, {
            maxTurns: 1, collectTraces: true,
            hitl: { level: 'consent', requireConsentFor: { tools: ['publish'] } },
        });
        expect(execution).toHaveBeenCalledTimes(1);
        expect(result.traces?.[0]?.shield?.action).toBe('defer');
        expect(result.traces?.[0]?.manifestConsent).toBeUndefined();
    });
});
