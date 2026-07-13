import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import { normalizeObservationInbox } from '../src/loop/types.js';
import { deriveConsentEffectKey, digestIntent } from '../src/loop/manifestConsent.js';
import { applyInputProvided } from '../src/orchestration/DurableHandlerRegistry.js';

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
    const receipt = (status: 'pending' | 'approved' | 'dispatching' | 'consumed' | 'rejected' = 'pending') => {
        const value: any = {
            token: 'consent-token', taskId: 'consent-task', agentId: 'agent-a', tenantId: 'tenant-a',
            intentId: 'activate_bundle', intentDigest: digestIntent(intent as any), requestedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(), effectIdempotencyKey: '', status,
        };
        value.effectIdempotencyKey = deriveConsentEffectKey(value);
        return value;
    };
    const context = (overrides: Record<string, unknown> = {}) => ({
        task: { id: 'consent-task', input: {} }, tenantId: 'tenant-a', agentId: 'agent-a',
        reply: jest.fn(), flushSnapshot: jest.fn(async () => undefined),
        ...overrides,
    });
    const options = {
        maxTurns: 1, collectTraces: true,
        hitl: { requireConsentFor: { intents: ['activate_bundle'] } },
    };

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
        const approvedReceipt = receipt('approved');
        const state = env() as any;
        state.pending.manifestConsents[approvedReceipt.token] = approvedReceipt;
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
        expect(seenKeys).toEqual([approvedReceipt.effectIdempotencyKey]);
        expect(approvedReceipt.status).toBe('consumed');
        expect(ctx.effect).toBeUndefined();
        expect(result.traces?.[0]?.manifestConsent).toMatchObject({ action: 'consume', receiptStatus: 'consumed' });
    });

    it('restores a persisted pending receipt, approves it, and executes the exact re-proposal', async () => {
        const state = env() as any;
        const firstCtx: any = context({ requestInput: jest.fn(async () => ({ token: 'consent-token' })) });
        const execution = jest.fn(async () => ({ action: { kind: 'internal', done: true }, result: { status: 'ok' } }));
        await runLoop(firstCtx, initialM(firstCtx), state, { policy: () => intent, execution } as any, options);
        state.pending.inputs['consent-token'] = { expiresAt: state.pending.manifestConsents['consent-token'].expiresAt };

        const persisted = JSON.parse(JSON.stringify({
            meta: { turn: 1, agentId: 'agent-a' },
            pending: state.pending,
            inbox: state.inbox,
        }));
        const { next } = applyInputProvided(persisted, 'consent-token', { decision: 'approve' }, {
            tenantId: 'tenant-a', taskId: 'consent-task', agentId: 'agent-a',
        });
        const resumed = { ...env(), pending: (next as any).pending, inbox: (next as any).inbox } as any;
        const resumeCtx: any = context();

        await runLoop(resumeCtx, initialM(resumeCtx), resumed, {
            policy: () => intent,
            execution,
            transition: () => ({ kind: 'complete', result: { ok: true } }),
        } as any, options);

        expect(execution).toHaveBeenCalledTimes(1);
        expect(resumed.pending.manifestConsents['consent-token'].status).toBe('consumed');
    });

    it('keeps rejection non-executing through structured resume and re-proposal', async () => {
        const pendingReceipt = receipt('pending');
        const snapshot: any = {
            meta: { turn: 1, agentId: 'agent-a' },
            pending: { inputs: { [pendingReceipt.token]: {} }, manifestConsents: { [pendingReceipt.token]: pendingReceipt } },
            inbox: normalizeObservationInbox(undefined),
        };
        const { next } = applyInputProvided(snapshot, pendingReceipt.token, { decision: 'reject' }, {
            tenantId: 'tenant-a', taskId: 'consent-task', agentId: 'agent-a',
        });
        const state = { ...env(), pending: (next as any).pending, inbox: (next as any).inbox } as any;
        const execution = jest.fn();
        const ctx: any = context({ requestInput: jest.fn(async () => ({ token: 'replacement-token' })) });

        const result = await runLoop(ctx, initialM(ctx), state, { policy: () => intent, execution } as any, options);

        expect(execution).not.toHaveBeenCalled();
        expect(state.pending.manifestConsents[pendingReceipt.token].status).toBe('rejected');
        expect(result.outcome).toEqual({ kind: 'await_input', token: 'replacement-token' });
    });

    it('retries a restored dispatching receipt with the same effect key and one logical effect', async () => {
        const dispatchingReceipt = receipt('dispatching');
        const state = env() as any;
        state.pending.manifestConsents[dispatchingReceipt.token] = dispatchingReceipt;
        const committedKeys = new Set<string>();
        const seenKeys: string[] = [];
        let logicalEffects = 0;
        let crashAfterEffect = true;
        const ctx: any = context();
        const execution = jest.fn(async () => {
            const key = ctx.effect.idempotencyKey;
            seenKeys.push(key);
            if (!committedKeys.has(key)) {
                committedKeys.add(key);
                logicalEffects++;
            }
            if (crashAfterEffect) {
                crashAfterEffect = false;
                throw new Error('worker crashed after effect');
            }
            return { action: { kind: 'internal', done: true }, result: { status: 'ok' } };
        });
        const modules = {
            policy: () => intent,
            execution,
            transition: () => ({ kind: 'complete', result: { ok: true } }),
        } as any;

        const failed = await runLoop(ctx, initialM(ctx), state, modules, options);
        expect(failed.outcome).toMatchObject({ kind: 'fail' });
        expect((failed.outcome as any).error).toMatchObject({ message: expect.stringContaining('worker crashed after effect') });
        expect(state.pending.manifestConsents[dispatchingReceipt.token].status).toBe('dispatching');

        const persisted = JSON.parse(JSON.stringify(state));
        const resumed = { ...env(), pending: persisted.pending, inbox: persisted.inbox } as any;
        await runLoop(ctx, initialM(ctx), resumed, modules, options);

        expect(seenKeys).toEqual([dispatchingReceipt.effectIdempotencyKey, dispatchingReceipt.effectIdempotencyKey]);
        expect(logicalEffects).toBe(1);
        expect(resumed.pending.manifestConsents[dispatchingReceipt.token].status).toBe('consumed');
    });

    it('rejects consumed receipt replay and never executes from the stale authorization', async () => {
        const consumedReceipt = receipt('consumed');
        const snapshot: any = {
            pending: { inputs: { [consumedReceipt.token]: {} }, manifestConsents: { [consumedReceipt.token]: consumedReceipt } },
            inbox: normalizeObservationInbox(undefined),
        };
        expect(() => applyInputProvided(snapshot, consumedReceipt.token, { decision: 'approve' }, {
            tenantId: 'tenant-a', taskId: 'consent-task', agentId: 'agent-a',
        })).toThrow('MANIFEST_CONSENT_ALREADY_DECIDED');

        const state = { ...env(), pending: snapshot.pending, inbox: snapshot.inbox } as any;
        const execution = jest.fn();
        const ctx: any = context({ requestInput: jest.fn(async () => ({ token: 'replacement-token' })) });
        await runLoop(ctx, initialM(ctx), state, { policy: () => intent, execution } as any, options);

        expect(execution).not.toHaveBeenCalled();
        expect(state.pending.manifestConsents[consumedReceipt.token].status).toBe('consumed');
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
