import { memberId, type TaskContext, type MentalState, type MemoryReader, type Intent } from '@a2arium/callagent-core';
import type { ExecOutcome } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { ExecPayload, ExecError, Sensory } from './types.js';
import {
    DEMO_CHILD_AGENT_ID,
    DEMO_INVITEE_AGENT_ID,
    DEMO_THREAD_ID,
    DEMO_THIRD_MEMBER_ID,
    DEMO_TOPIC_PHASE2_ID,
} from './types.js';

const log = logger.createLogger({ prefix: 'conversation-reference-agent' });

const OUTSIDER_AGENT_ID = 'definitely-not-a-member-xyz';
const DEMO_OWNER_SEAT_A = memberId('conversation-reference-agent#owner');
const DEMO_OWNER_SEAT_B = memberId('conversation-reference-agent#participant');

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
    if (intent.intent === 'conversation_phase2_run') {
        const childAgentId = (intent.data as { childAgentId?: string } | undefined)?.childAgentId ?? DEMO_CHILD_AGENT_ID;
        const topicRef = { kind: 'topic' as const, id: DEMO_TOPIC_PHASE2_ID };
        const created = await ctx.conversation.createTopic({
            topicId: DEMO_TOPIC_PHASE2_ID,
            members: [
                { agentId: ctx.agentId, memberId: DEMO_OWNER_SEAT_A, role: 'owner' },
                { agentId: ctx.agentId, memberId: DEMO_OWNER_SEAT_B, role: 'participant' },
                { agentId: childAgentId, role: 'participant' },
                {
                    agentId: DEMO_THIRD_MEMBER_ID,
                    role: 'participant',
                    sessionIdOverride: 'route-override:third-demo',
                },
            ],
            defaultSelector: { kind: 'round_robin' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        if (created.status === 'rejected') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: {
                        code: 'create_topic_failed',
                        message: created.error.message,
                    },
                },
            };
        }
        const topic = created.topic;

        const bcast = await ctx.conversation.post(
            topic,
            {
                senderAgentId: ctx.agentId,
                senderMemberId: DEMO_OWNER_SEAT_A,
                speechAct: 'inform',
                content: { step: 'p2_broadcast' },
            },
            { selector: { kind: 'broadcast' }, idempotencyKey: 'idem-p2-broadcast' }
        );
        if (bcast.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: { status: 'error', error: { code: 'p2_broadcast', message: 'broadcast post failed' } },
            };
        }

        const rr1 = await ctx.conversation.post(
            topic,
            { senderAgentId: ctx.agentId, senderMemberId: DEMO_OWNER_SEAT_A, speechAct: 'inform', content: { step: 'p2_rr1' } },
            { selector: { kind: 'round_robin' }, idempotencyKey: 'idem-p2-rr-1' }
        );
        const rr2 = await ctx.conversation.post(
            topic,
            { senderAgentId: ctx.agentId, senderMemberId: DEMO_OWNER_SEAT_A, speechAct: 'inform', content: { step: 'p2_rr2' } },
            { selector: { kind: 'round_robin' }, idempotencyKey: 'idem-p2-rr-2' }
        );
        if (rr1.status !== 'accepted' || rr2.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: { status: 'error', error: { code: 'p2_rr', message: 'round_robin post failed' } },
            };
        }
        if (
            rr1.status === 'accepted' &&
            rr2.status === 'accepted' &&
            rr1.deliveries[0]?.recipientAgentId === rr2.deliveries[0]?.recipientAgentId
        ) {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'p2_rr_same_recipient', message: 'expected two round_robin posts to target different members' },
                },
            };
        }

        const badExplicit = await ctx.conversation.post(
            topic,
            {
                senderAgentId: ctx.agentId,
                senderMemberId: DEMO_OWNER_SEAT_A,
                speechAct: 'inform',
                content: { step: 'p2_explicit_bad' },
            },
            {
                selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: OUTSIDER_AGENT_ID } },
                idempotencyKey: 'idem-p2-explicit',
            }
        );
        if (badExplicit.status !== 'rejected') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'p2_explicit', message: 'expected RecipientNotMember rejection' },
                },
            };
        }
        if (badExplicit.status === 'rejected' && badExplicit.error.type !== 'RecipientNotMember') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'p2_explicit_type', message: badExplicit.error.message },
                },
            };
        }

        const replay = await ctx.conversation.post(
            topic,
            {
                senderAgentId: ctx.agentId,
                senderMemberId: DEMO_OWNER_SEAT_A,
                speechAct: 'inform',
                content: { step: 'p2_broadcast' },
            },
            { selector: { kind: 'broadcast' }, idempotencyKey: 'idem-p2-broadcast' }
        );
        if (replay.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: { status: 'error', error: { code: 'p2_replay', message: 'idempotent replay failed' } },
            };
        }
        const dedupeOk =
            replay.deliveries.length > 0 ? replay.deliveries.every((d) => d.dedupeHit === true) : true;

        const inv = await ctx.conversation.invite({
            topic: topicRef,
            invitee: {
                agentId: DEMO_INVITEE_AGENT_ID,
                role: 'participant',
                sessionIdOverride: 'route-override:invitee',
            },
        });
        if (inv.status !== 'ok') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'p2_invite', message: inv.status === 'rejected' ? inv.error.message : 'invite failed' },
                },
            };
        }

        log.info('conversation.phase2_demo_complete', {
            topicId: topic.id,
            inviteTokenPrefix: inv.token.slice(0, 12),
            dedupeReplay: dedupeOk,
        });
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                data: {
                    topicId: topic.id,
                    topicPostDedupeHit: dedupeOk,
                    phase2DemoComplete: true,
                    inviteToken: inv.token,
                    ownerSeatMemberIds: [
                        DEMO_OWNER_SEAT_A,
                        DEMO_OWNER_SEAT_B,
                    ],
                    senderMemberIdUsed: DEMO_OWNER_SEAT_A,
                    rrRecipients: [rr1.deliveries[0]?.recipientAgentId, rr2.deliveries[0]?.recipientAgentId].filter(
                        (id): id is string => typeof id === 'string'
                    ),
                },
            },
        };
    }
    if (intent.intent === 'conversation_phase3_close_archive') {
        const thread = { kind: 'thread' as const, id: DEMO_THREAD_ID };
        const closed = await ctx.conversation.close(thread, { reason: 'phase3-demo', archiveAfter: true });
        if (closed.status !== 'ok' || !closed.closed || !closed.archived) {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'phase3_close', message: 'expected close with archiveAfter' },
                },
            };
        }
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                data: {
                    threadId: DEMO_THREAD_ID,
                    phase3ArchiveComplete: true,
                },
            },
        };
    }
    if (intent.intent === 'conversation_phase2_close') {
        const closed = await ctx.conversation.close({ kind: 'topic', id: DEMO_TOPIC_PHASE2_ID }, {});
        if (closed.status !== 'ok' || !closed.closed) {
            return {
                action: { kind: 'internal', done: true },
                result: { status: 'error', error: { code: 'p2_close', message: 'close did not persist' } },
            };
        }
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                data: {
                    topicId: DEMO_TOPIC_PHASE2_ID,
                    phase2CloseComplete: true,
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
