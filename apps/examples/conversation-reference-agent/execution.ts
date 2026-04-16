import type { TaskContext, MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { ExecOutcome } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { ExecPayload, ExecError, Sensory } from './types.js';
import { DEMO_CHILD_AGENT_ID, DEMO_THREAD_ID } from './types.js';

const log = logger.createLogger({ prefix: 'conversation-reference-agent' });

export async function execution(
    intent: Intent,
    ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<ExecOutcome<ExecPayload, ExecError>> {
    if (intent.kind === 'complete') {
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                data: {
                    threadId: DEMO_THREAD_ID,
                    ...(typeof intent.result === 'object' && intent.result !== null ? intent.result : {}),
                },
            },
        };
    }
    if (intent.kind === 'wait') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { threadId: DEMO_THREAD_ID, idle: true } },
        };
    }
    if (intent.kind !== 'internal') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'unexpected_intent', message: intent.kind } },
        };
    }
    if (!ctx.conversation) {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'no_conversation_api', message: 'TaskContext.conversation is not bound' } },
        };
    }
    if (intent.intent === 'conversation_demo_open') {
        const childAgentId = (intent.data as { childAgentId?: string } | undefined)?.childAgentId ?? DEMO_CHILD_AGENT_ID;
        const opened = await ctx.conversation.startThread({
            targetAgentId: childAgentId,
            conversationId: DEMO_THREAD_ID,
            message: {
                senderAgentId: ctx.agentId,
                speechAct: 'request',
                content: { step: 'open' },
            },
        });
        if (opened.receipt.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'start_thread_failed', message: 'startThread did not accept the first message' },
                },
            };
        }
        log.info('conversation.thread_opened', {
            threadId: opened.thread.id,
            recipientAgentId: childAgentId,
            outboundMessageId: opened.receipt.messageId,
            sequenceNumber: opened.receipt.sequenceNumber,
        });
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                data: {
                    threadId: opened.thread.id,
                    outgoingSteps: 1,
                    openOutboundMessageId: opened.receipt.messageId,
                    openOutboundSequence: opened.receipt.sequenceNumber,
                },
            },
        };
    }
    if (intent.intent === 'conversation_demo_follow_up') {
        const childAgentId = (intent.data as { childAgentId?: string } | undefined)?.childAgentId ?? DEMO_CHILD_AGENT_ID;
        const thread = { kind: 'thread' as const, id: DEMO_THREAD_ID };
        const first = await ctx.conversation.send(
            thread,
            {
                senderAgentId: ctx.agentId,
                recipientAgentId: childAgentId,
                speechAct: 'question',
                content: { step: 'follow_up' },
            },
            { idempotencyKey: 'idem-followup-1' }
        );
        const replay = await ctx.conversation.send(
            thread,
            {
                senderAgentId: ctx.agentId,
                recipientAgentId: childAgentId,
                speechAct: 'question',
                content: { step: 'follow_up' },
            },
            { idempotencyKey: 'idem-followup-1' }
        );
        if (first.status !== 'accepted' || replay.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'send_failed', message: 'Follow-up or replay send was not accepted' },
                },
            };
        }
        log.info('conversation.follow_up_sent', {
            threadId: thread.id,
            recipientAgentId: childAgentId,
            firstMessageId: first.messageId,
            replayMessageId: replay.messageId,
            replayDedupeHit: replay.dedupeHit === true,
            firstSequenceNumber: first.sequenceNumber,
            replaySequenceNumber: replay.sequenceNumber,
        });
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                data: {
                    threadId: thread.id,
                    lastDedupeHit: replay.dedupeHit === true,
                    outgoingSteps: 2,
                    followUpFirstMessageId: first.messageId,
                    followUpReplayMessageId: replay.messageId,
                    followUpFirstSequence: first.sequenceNumber,
                    followUpReplaySequence: replay.sequenceNumber,
                },
            },
        };
    }
    return {
        action: { kind: 'internal', done: true },
        result: { status: 'error', error: { code: 'unknown_intent', message: intent.intent } },
    };
}
