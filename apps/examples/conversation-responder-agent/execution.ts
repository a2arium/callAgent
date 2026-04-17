import type { TaskContext, MentalState, MemoryReader, Intent, ExecOutcome } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { ExecPayload, ExecError, Sensory } from './types.js';
import { DEMO_TOPIC_PHASE2_ID } from './types.js';

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
    if (intent.kind !== 'internal') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'bad_intent', message: intent.kind } },
        };
    }
    if (!ctx.conversation) {
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'error',
                error: { code: 'reply_precondition', message: 'TaskContext.conversation is not bound' },
            },
        };
    }

    if (intent.intent === 'conversation_responder_topic_join') {
        const token = (intent.data as { token?: string } | undefined)?.token;
        if (!token) {
            return {
                action: { kind: 'internal', done: true },
                result: { status: 'error', error: { code: 'join_token', message: 'missing invite token' } },
            };
        }
        const topic = { kind: 'topic' as const, id: DEMO_TOPIC_PHASE2_ID };
        const r = await ctx.conversation.join(topic, { inviteToken: token });
        if (r.status !== 'ok') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'topic_join_rejected', message: r.status === 'rejected' ? r.error.message : 'join failed' },
                },
            };
        }
        log.info('conversation.topic_joined', { topicId: topic.id });
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { topicId: topic.id, topicJoined: true, joinContinue: true } },
        };
    }

    if (intent.intent === 'conversation_responder_topic_reply') {
        const topic = { kind: 'topic' as const, id: DEMO_TOPIC_PHASE2_ID };
        const receipt = await ctx.conversation.post(
            topic,
            {
                senderAgentId: ctx.agentId,
                speechAct: 'inform',
                content: { step: 'responder_topic_ack' },
            },
            { selector: { kind: 'broadcast' }, idempotencyKey: 'idem-responder-topic-reply-1' }
        );
        if (receipt.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'topic_post_rejected', message: 'topic reply was not accepted' },
                },
            };
        }
        log.info('conversation.topic_reply_sent', { topicId: topic.id });
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                data: { topicId: topic.id, topicReplySent: true, topicReplyContinue: true },
            },
        };
    }

    if (intent.intent === 'conversation_responder_topic_leave') {
        const topic = { kind: 'topic' as const, id: DEMO_TOPIC_PHASE2_ID };
        const r = await ctx.conversation.leave(topic, {});
        if (r.status !== 'ok') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'topic_leave_rejected', message: r.status === 'rejected' ? r.error.message : 'leave failed' },
                },
            };
        }
        log.info('conversation.topic_left', { topicId: topic.id });
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { topicId: topic.id, leaveContinue: true } },
        };
    }

    if (intent.intent === 'conversation_responder_reply') {
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
        if (!threadId) {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: {
                        code: 'reply_precondition',
                        message: 'missing threadId',
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
