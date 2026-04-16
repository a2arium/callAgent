import type { TaskContext, MentalState, MemoryReader, Intent, ExecOutcome } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { ExecPayload, ExecError, Sensory } from './types.js';

const log = logger.createLogger({ prefix: 'conversation-responder-agent' });

export async function execution(
    intent: Intent,
    ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<ExecOutcome<ExecPayload, ExecError>> {
    if (intent.kind === 'complete') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: intent.result ?? { acknowledged: true } },
        };
    }
    if (intent.kind === 'wait') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { acknowledged: false } },
        };
    }
    if (intent.kind === 'internal' && intent.intent === 'conversation_responder_reply') {
        const data = intent.data as
            | {
                  threadId?: string;
                  initiatorAgentId?: string;
                  inboundMessageId?: string;
                  inboundSequence?: number;
              }
            | undefined;
        const threadId = data?.threadId;
        const initiatorAgentId = data?.initiatorAgentId ?? 'conversation-reference-agent';
        const idempotencyKey =
            typeof data?.inboundMessageId === 'string' && data.inboundMessageId.length > 0
                ? `idem-responder-reply:${data.inboundMessageId}`
                : `idem-responder-reply:${threadId ?? 'unknown'}:${data?.inboundSequence ?? 0}`;
        if (!threadId || !ctx.conversation) {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: {
                        code: 'reply_precondition',
                        message: !ctx.conversation ? 'TaskContext.conversation not bound' : 'missing threadId',
                    },
                },
            };
        }
        const receipt = await ctx.conversation.send(
            { kind: 'thread', id: threadId },
            {
                senderAgentId: ctx.agentId,
                recipientAgentId: initiatorAgentId,
                speechAct: 'inform',
                content: { step: 'responder_ack' },
            },
            { idempotencyKey }
        );
        if (receipt.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'reply_send_rejected', message: 'Responder reply was not accepted' },
                },
            };
        }
        log.info('conversation.reply_sent', {
            threadId,
            initiatorAgentId,
            idempotencyKey,
            outboundMessageId: receipt.messageId,
            sequenceNumber: receipt.sequenceNumber,
        });
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                data: { replyOutbound: true, threadId, outboundMessageId: receipt.messageId },
            },
        };
    }
    return {
        action: { kind: 'internal', done: true },
        result: {
            status: 'error',
            error: { code: 'unsupported_intent', message: 'Unsupported responder intent' },
        },
    };
}
