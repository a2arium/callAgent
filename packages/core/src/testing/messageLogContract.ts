import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { z } from 'zod';
import { MemberIdSchema, SpeechActSchema } from '../public-types/conversation/schemas.js';

type SpeechAct = z.infer<typeof SpeechActSchema>;
import type { MessageLog } from '../public-types/messageLog/types.js';

export type MessageLogContractContext = {
    messageLog: MessageLog;
    close?: () => Promise<void>;
};

export type MessageLogContractFactory = () => Promise<MessageLogContractContext>;

const tenantId = 'contract-tenant';
const conversationId = 'contract-conv';

function baseAppend(speechAct: SpeechAct, payload: unknown, idempotencyKey?: string) {
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
 * Shared MessageLog contract (5.4c.1).
 */
export function runMessageLogContract(suiteName: string, factory: MessageLogContractFactory): void {
    describe(suiteName, () => {
        let log: MessageLog;
        let close: (() => Promise<void>) | undefined;

        beforeEach(async () => {
            const ctx = await factory();
            log = ctx.messageLog;
            close = ctx.close;
        });

        afterEach(async () => {
            await close?.();
            close = undefined;
        });

        it('append with idempotencyKey returns dedupeHit on replay', async () => {
            const params = baseAppend('inform', { v: 1 }, 'idem-contract-1');
            const first = await log.append(params);
            const second = await log.append(params);
            expect(first.kind).toBe('appended');
            expect(second.kind).toBe('dedupeHit');
            if (first.kind === 'appended' && second.kind === 'dedupeHit') {
                expect(second.messageId).toBe(first.messageId);
                expect(second.sequenceNumber).toBe(first.sequenceNumber);
            }
        });

        it('read supports fromSequence and limit pagination', async () => {
            await log.append(baseAppend('inform', { n: 1 }));
            await log.append(baseAppend('inform', { n: 2 }));
            await log.append(baseAppend('inform', { n: 3 }));
            await log.append(baseAppend('inform', { n: 4 }));
            const all = await log.read({ tenantId, conversationId });
            expect(all.length).toBeGreaterThanOrEqual(4);
            const fromSeq = all[1]!.sequenceNumber;
            const page = await log.read({ tenantId, conversationId, fromSequence: fromSeq, limit: 2 });
            expect(page.length).toBeGreaterThanOrEqual(1);
            expect(page.every((r) => r.sequenceNumber >= fromSeq)).toBe(true);
        });

        it('replay async-iterates records', async () => {
            await log.append(baseAppend('inform', { k: 'a' }));
            await log.append(baseAppend('inform', { k: 'b' }));
            const keys: string[] = [];
            for await (const row of log.replay({ tenantId, conversationId, limit: 20 })) {
                keys.push((row.payload as { k: string }).k);
            }
            expect(keys.length).toBeGreaterThanOrEqual(2);
            expect(keys).toContain('a');
            expect(keys).toContain('b');
        });

        it('findByIdempotency returns the original row', async () => {
            const key = 'find-idem-99';
            const appended = await log.append(baseAppend('inform', { hello: 'world' }, key));
            expect(appended.kind).toBe('appended');
            const found = await log.findByIdempotency({
                tenantId,
                conversationId,
                senderMemberId: MemberIdSchema.parse('member-s'),
                idempotencyKey: key,
            });
            expect(found).not.toBeNull();
            if (found && appended.kind === 'appended') {
                expect(found.messageId).toBe(appended.messageId);
                expect(found.sequenceNumber).toBe(appended.sequenceNumber);
            }
        });
    });
}
