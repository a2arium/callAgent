import { describe, expect, it, jest } from '@jest/globals';
import { ApiBinder } from '../src/orchestration/api/ApiBinder.js';

function activeSnapshot(state: 'active' | 'failed' = 'active') {
    return {
        meta: {
            agentId: 'agent-a',
            taskLifecycle: {
                taskId: 'task-a',
                rootTaskId: 'task-a',
                ancestorTaskIds: [],
                state,
                ...(state === 'failed' ? { reason: 'domain_failure' } : {}),
            },
        },
        pending: { tools: {} },
    };
}

function harness(state: 'active' | 'failed' = 'active') {
    let current = { snapshot: activeSnapshot(state), wmVersion: BigInt(1), agentId: 'agent-a' };
    const sessionManager = {
        load: jest.fn(async () => current),
        saveSnapshot: jest.fn(async (params: { snapshot: Record<string, unknown> }) => {
            current = { ...current, snapshot: params.snapshot, wmVersion: current.wmVersion + BigInt(1) };
            return { newVersion: current.wmVersion };
        }),
        appendEvent: jest.fn(),
        enqueueOutbox: jest.fn(),
    };
    const runOwnedEffect = jest.fn(async <T>(
        factory: (control: { signal: AbortSignal }) => Promise<T>,
    ) => factory({ signal: new AbortController().signal }));
    const binder = new ApiBinder({
        sessionManager,
        snapshotRepo: {},
        getTraceContext: () => ({}),
        getSessionStorePrisma: () => undefined,
        taskCreationMutex: { runExclusive: async (_key: string, fn: () => Promise<unknown>) => fn() },
        backgroundTaskPromises: new Set(),
        runOwnedEffect,
        conversationService: {},
    } as never);
    const ctx = {
        tenantId: 'tenant-a',
        agentId: 'agent-a',
        task: { id: 'task-a', input: {} },
    } as any;
    return { binder, ctx, runOwnedEffect, sessionManager };
}

describe('ApiBinder external registered effects', () => {
    it('registers before invoking and forwards the exact idempotency key and owned signal', async () => {
        const h = harness();
        await h.binder.attachOrchestrationAPIs(h.ctx, {
            tenantId: 'tenant-a', sessionId: 'task-a', agentId: 'agent-a', flushMentalState: async () => {},
        });
        const callback = jest.fn(async ({ signal, idempotencyKey }) => ({ aborted: signal.aborted, idempotencyKey }));
        await expect(h.ctx.effects.run({
            kind: 'callkg.ingestion.create',
            operation: 'anac.publication.ingestion.create',
            idempotencyKey: 'batch-stable-key',
        }, callback)).resolves.toEqual({ aborted: false, idempotencyKey: 'batch-stable-key' });
        expect(h.sessionManager.saveSnapshot).toHaveBeenCalledTimes(1);
        expect(h.runOwnedEffect).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
            kind: 'agent.external.callkg.ingestion.create',
            source: 'ApiBinder.effects.run',
        }));
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('rejects a terminal task before the external callback begins', async () => {
        const h = harness('failed');
        await h.binder.attachOrchestrationAPIs(h.ctx, {
            tenantId: 'tenant-a', sessionId: 'task-a', agentId: 'agent-a', flushMentalState: async () => {},
        });
        const callback = jest.fn(async () => 'should-not-run');
        await expect(h.ctx.effects.run({
            kind: 'callkg.ingestion.create', idempotencyKey: 'batch-stable-key',
        }, callback)).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_TERMINAL' });
        expect(h.runOwnedEffect).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });

    it('rejects unsafe effect identities before registration', async () => {
        const h = harness();
        await h.binder.attachOrchestrationAPIs(h.ctx, {
            tenantId: 'tenant-a', sessionId: 'task-a', agentId: 'agent-a', flushMentalState: async () => {},
        });
        await expect(h.ctx.effects.run({ kind: '../unsafe', idempotencyKey: 'key' }, async () => undefined))
            .rejects.toMatchObject({ code: 'TASK_EFFECT_KIND_INVALID' });
        await expect(h.ctx.effects.run({ kind: 'safe', idempotencyKey: 'bad\nkey' }, async () => undefined))
            .rejects.toMatchObject({ code: 'TASK_EFFECT_IDEMPOTENCY_KEY_INVALID' });
        expect(h.sessionManager.saveSnapshot).not.toHaveBeenCalled();
    });
});
