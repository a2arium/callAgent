import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { z } from 'zod';
import { MemberIdSchema, SpeechActSchema } from '../public-types/conversation/schemas.js';

type SpeechAct = z.infer<typeof SpeechActSchema>;
import type { DurableSubscription } from '../public-types/messageLog/durableSubscription.types.js';
import type { MessageLog } from '../public-types/messageLog/types.js';
import type { IEventBus } from '../public-types/eventbus/types.js';

export type DurableSubscriptionContractContext = {
    durable: DurableSubscription;
    tenantId: string;
    streamId: string;
    consumerId: string;
    messageLog: MessageLog;
    eventBus: IEventBus;
    /** Expected max handler attempts per record (matches `createInProcessDurableSubscription` option). */
    expectedMaxHandlerRetries: number;
    close?: () => Promise<void>;
};

export type DurableSubscriptionContractFactory = () => Promise<DurableSubscriptionContractContext>;

function baseAppend(
    tenantId: string,
    conversationId: string,
    speechAct: SpeechAct,
    payload: unknown,
    idempotencyKey?: string
) {
    return {
        tenantId,
        conversationId,
        conversationKind: 'topic' as const,
        senderAgentId: 'agent-s',
        senderMemberId: MemberIdSchema.parse('member-s'),
        speechAct,
        payload,
        deliveries: [
            {
                recipientAgentId: 'agent-r',
                recipientMemberId: MemberIdSchema.parse('member-r'),
                sessionId: 'session-r',
            },
        ],
        ...(idempotencyKey ? { idempotencyKey } : {}),
    };
}

/**
 * Shared DurableSubscription contract (5.4c.1).
 */
export function runDurableSubscriptionContract(suiteName: string, factory: DurableSubscriptionContractFactory): void {
    describe(suiteName, () => {
        let ctx: DurableSubscriptionContractContext;

        beforeEach(async () => {
            ctx = await factory();
        });

        afterEach(async () => {
            await ctx.close?.();
        });

        it('replay delivers at-least-once and handler ack advances cursor', async () => {
            const { durable, tenantId, streamId, messageLog } = ctx;
            await messageLog.append(baseAppend(tenantId, streamId, 'inform', { x: 1 }, 'd1-idem'));
            let saw = 0;
            const { unsubscribe } = await durable.subscribe({
                streamId,
                consumerId: `${ctx.consumerId}-ack`,
                startFrom: 'earliest',
                handler: async () => {
                    saw += 1;
                    return 'ack';
                },
            });
            expect(saw).toBe(1);
            const cur = await durable.getCursor({ streamId, consumerId: `${ctx.consumerId}-ack` });
            expect(cur).not.toBeNull();
            expect(cur!.sequenceNumber).toBeGreaterThanOrEqual(0);
            await unsubscribe();
        });

        it('setCursor is reflected in getCursor', async () => {
            const { durable, streamId, consumerId } = ctx;
            const iso = new Date().toISOString();
            await durable.setCursor({
                streamId,
                consumerId: `${consumerId}-cursor`,
                sequenceNumber: 7,
                updatedAt: iso,
            });
            const cur = await durable.getCursor({ streamId, consumerId: `${consumerId}-cursor` });
            expect(cur?.sequenceNumber).toBe(7);
            expect(cur?.updatedAt).toBe(iso);
        });

        it('nack from handler triggers retry then ack', async () => {
            const { durable, tenantId, streamId, consumerId, messageLog } = ctx;
            await messageLog.append(baseAppend(tenantId, streamId, 'inform', { r: true }, 'n1-idem'));
            let calls = 0;
            const { unsubscribe } = await durable.subscribe({
                streamId,
                consumerId: `${consumerId}-nack`,
                startFrom: 'earliest',
                handler: async () => {
                    calls += 1;
                    if (calls < 2) {
                        return { nack: true, reason: 'retry-once' };
                    }
                    return 'ack';
                },
            });
            expect(calls).toBe(2);
            await unsubscribe();
        });

        it('explicit ack() updates getCursor', async () => {
            const { durable, tenantId, streamId, consumerId, messageLog } = ctx;
            const app = await messageLog.append(baseAppend(tenantId, streamId, 'inform', {}, 'ack-api-idem'));
            expect(app.kind).toBe('appended');
            if (app.kind !== 'appended') {
                return;
            }
            await durable.ack({
                streamId,
                consumerId: `${consumerId}-manual`,
                sequenceNumber: app.sequenceNumber,
                messageId: app.messageId,
            });
            const cur = await durable.getCursor({ streamId, consumerId: `${consumerId}-manual` });
            expect(cur?.sequenceNumber).toBe(app.sequenceNumber);
        });

        it('exhausts maxHandlerRetries when handler always nacks', async () => {
            const { durable, tenantId, streamId, consumerId, messageLog, expectedMaxHandlerRetries } = ctx;
            await messageLog.append(baseAppend(tenantId, streamId, 'inform', { z: 1 }, 'dlq-idem'));
            let calls = 0;
            await durable.subscribe({
                streamId,
                consumerId: `${consumerId}-dlq`,
                startFrom: 'earliest',
                handler: async () => {
                    calls += 1;
                    return { nack: true, reason: 'always' };
                },
            });
            expect(calls).toBe(expectedMaxHandlerRetries);
        });
    });
}
