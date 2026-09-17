import { describe, expect, it } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import type {
    ConversationActivateParams,
    ConversationActivateResult,
} from '../src/internal/conversation/types.js';

type ActivationSerialHarness = {
    trackBackgroundTask<T>(promise: Promise<T>): Promise<T>;
    waitForBackgroundTasks(timeoutMs?: number): Promise<void>;
    runConversationActivationSerial(params: ConversationActivateParams): Promise<ConversationActivateResult>;
    ensureConversationActivation(params: ConversationActivateParams): Promise<ConversationActivateResult>;
    runConversationActivationBody(params: ConversationActivateParams): Promise<ConversationActivateResult>;
    hasCurrentInboundConversationDelivery(params: ConversationActivateParams | undefined): Promise<boolean>;
    releaseConversationActivation(activationKey: string): Promise<ConversationActivateResult | undefined>;
};

const activationParams = (
    messageId: string,
    routingSessionId = 'topic-t:seat'
): ConversationActivateParams => ({
    kind: 'thread',
    tenantId: 'tenant',
    threadId: 'topic-t',
    routingSessionId,
    recipientAgentId: 'agent',
    messageId,
    senderSessionId: 'sender',
    senderAgentId: 'sender-agent',
});

describe('conversation activation serialization', () => {
    it('coalesces re-entrant activation for the same member session until the active turn finishes', async () => {
        const engine = new TaskEngine({});
        const harness = engine as unknown as ActivationSerialHarness;
        const calls: string[] = [];
        let releaseFirst: (() => void) | undefined;
        let markFirstStarted: (() => void) | undefined;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstCanFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        harness.runConversationActivationBody = async (
            params: ConversationActivateParams
        ): Promise<ConversationActivateResult> => {
            calls.push(params.messageId);
            if (params.messageId === 'm1') {
                markFirstStarted?.();
                await firstCanFinish;
            }
            return { ok: true };
        };

        const first = harness.runConversationActivationSerial(activationParams('m1'));
        await firstStarted;
        const second = harness.runConversationActivationSerial(activationParams('m2'));

        let secondResolved = false;
        second.then(() => {
            secondResolved = true;
        });
        await Promise.resolve();
        expect(secondResolved).toBe(false);
        expect(calls).toEqual(['m1']);

        releaseFirst?.();
        await expect(first).resolves.toEqual({ ok: true });
        await expect(second).resolves.toEqual({ ok: true });
        expect(calls).toEqual(['m1', 'm2']);
    });

    it('admits a same-session conversation activation without waiting on a process-local turn queue', async () => {
        const engine = new TaskEngine({});
        const harness = engine as unknown as ActivationSerialHarness;
        const calls: string[] = [];
        let releaseTurn: (() => void) | undefined;
        let markTurnStarted: (() => void) | undefined;
        const turnStarted = new Promise<void>((resolve) => {
            markTurnStarted = resolve;
        });
        const turnCanFinish = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });

        harness.runConversationActivationBody = async (
            params: ConversationActivateParams
        ): Promise<ConversationActivateResult> => {
            calls.push(params.messageId);
            return { ok: true };
        };

        const activeTurn = (async () => {
            markTurnStarted?.();
            await turnCanFinish;
            return 'turn-finished';
        })();
        await turnStarted;

        const activation = harness.runConversationActivationSerial(
            activationParams('reply-1', 'local-task-1')
        );

        let activationResolved = false;
        activation.then(() => {
            activationResolved = true;
        });
        await Promise.resolve();
        expect(calls).toEqual(['reply-1']);

        releaseTurn?.();
        await expect(activeTurn).resolves.toBe('turn-finished');
        await expect(activation).resolves.toEqual({ ok: true });
        expect(calls).toEqual(['reply-1']);
    });

    it('drains an activation queued during release instead of leaving it pending', async () => {
        const engine = new TaskEngine({});
        const harness = engine as unknown as ActivationSerialHarness;
        const calls: string[] = [];

        harness.runConversationActivationBody = async (
            params: ConversationActivateParams
        ): Promise<ConversationActivateResult> => {
            calls.push(params.messageId);
            return { ok: true };
        };

        const queued = harness.runConversationActivationSerial(
            activationParams('reply-release', 'local-task-release')
        );

        await expect(queued).resolves.toEqual({ ok: true });
        expect(calls).toEqual(['reply-release']);
    });

    it('waits for conversation activations scheduled by background activations', async () => {
        const engine = new TaskEngine({});
        const harness = engine as unknown as ActivationSerialHarness;
        const completed: string[] = [];
        let resolveFirst: (() => void) | undefined;
        let resolveSecond: (() => void) | undefined;
        const first = new Promise<void>((resolve) => {
            resolveFirst = resolve;
        });
        const second = new Promise<void>((resolve) => {
            resolveSecond = resolve;
        });

        harness.trackBackgroundTask(
            first.then(() => {
                completed.push('first');
                harness.trackBackgroundTask(
                    second.then(() => {
                        completed.push('second');
                    })
                );
            })
        );

        const wait = harness.waitForBackgroundTasks(1000);
        resolveFirst?.();
        await Promise.resolve();
        resolveSecond?.();

        await wait;
        expect(completed).toEqual(['first', 'second']);
    });

    it('waits through an idle handoff for a background activation scheduled shortly after drain starts', async () => {
        const engine = new TaskEngine({});
        const harness = engine as unknown as ActivationSerialHarness;
        const completed: string[] = [];
        let resolveLate: (() => void) | undefined;
        const late = new Promise<void>((resolve) => {
            resolveLate = resolve;
        });

        setTimeout(() => {
            harness.trackBackgroundTask(
                late.then(() => {
                    completed.push('late');
                })
            );
            resolveLate?.();
        }, 10);

        await harness.waitForBackgroundTasks(1000);
        expect(completed).toEqual(['late']);
    });

    it('reruns a conversation activation when an inbound delivery remains current after save', async () => {
        const engine = new TaskEngine({});
        const harness = engine as unknown as ActivationSerialHarness;
        const calls: string[] = [];

        harness.runConversationActivationBody = async (
            params: ConversationActivateParams
        ): Promise<ConversationActivateResult> => {
            calls.push(params.messageId);
            return { ok: true };
        };
        harness.hasCurrentInboundConversationDelivery = async () => calls.length === 1;

        await expect(
            harness.runConversationActivationSerial(activationParams('reply-current'))
        ).resolves.toEqual({ ok: true });
        expect(calls).toEqual(['reply-current', 'reply-current']);
    });

    it('reconciles recent activation targets with current inbound deliveries before drain exits', async () => {
        const engine = new TaskEngine({});
        const harness = engine as unknown as ActivationSerialHarness;
        const calls: string[] = [];

        harness.runConversationActivationBody = async (
            params: ConversationActivateParams
        ): Promise<ConversationActivateResult> => {
            calls.push(params.messageId);
            return { ok: true };
        };
        harness.hasCurrentInboundConversationDelivery = async () => calls.length === 0;

        await harness.ensureConversationActivation(activationParams('reply-reconcile'));
        calls.length = 0;

        await harness.waitForBackgroundTasks(1000);
        expect(calls).toEqual(['reply-reconcile']);
    });

    it('reconciliation queues behind an active session instead of skipping it', async () => {
        const engine = new TaskEngine({});
        const harness = engine as unknown as ActivationSerialHarness;
        const calls: string[] = [];
        let releaseFirst: (() => void) | undefined;
        let markFirstStarted: (() => void) | undefined;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstCanFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        harness.runConversationActivationBody = async (
            params: ConversationActivateParams
        ): Promise<ConversationActivateResult> => {
            calls.push(params.messageId);
            if (calls.length === 1) {
                markFirstStarted?.();
                await firstCanFinish;
            }
            return { ok: true };
        };
        harness.hasCurrentInboundConversationDelivery = async () => calls.length < 2;

        harness.trackBackgroundTask(
            harness.ensureConversationActivation(activationParams('reply-active-reconcile'))
        );
        await firstStarted;

        const wait = harness.waitForBackgroundTasks(1000);
        releaseFirst?.();
        await wait;

        expect(calls).toEqual(['reply-active-reconcile', 'reply-active-reconcile']);
    });
});
