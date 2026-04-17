import type { EnvironmentState, MemoryReader, Observation } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { Obs } from './types.js';
import { DEMO_TOPIC_PHASE2_ID } from './types.js';

const log = logger.createLogger({ prefix: 'conversation-responder-agent' });

function getUserText(env: EnvironmentState): string | undefined {
    const userObs = env.inbox.current.find((o) => o.source === 'user' && o.kind === 'input.provided');
    if (!userObs) {
        return undefined;
    }
    const payload = userObs.payload as { value?: unknown };
    const v = payload?.value;
    if (typeof v === 'string') {
        return v;
    }
    if (v && typeof v === 'object' && v !== null && 'text' in v) {
        return String((v as { text: unknown }).text);
    }
    return undefined;
}

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    const userText = getUserText(env);
    if (userText === 'join' && typeof process !== 'undefined' && process.env.CALLAGENT_TOPIC_INVITE_TOKEN) {
        return {
            kind: 'topic_join',
            token: process.env.CALLAGENT_TOPIC_INVITE_TOKEN,
        };
    }
    if (userText === 'leave-topic') {
        return { kind: 'leave_topic' };
    }

    for (const obs of env.inbox.current) {
        const o = obs as Observation;
        const phase = (o.payload as { phase?: string }).phase;
        if (o.source === 'internal' && o.kind === 'state.noted' && phase === 'topic_joined') {
            return { kind: 'topic_joined' };
        }
        if (o.source === 'internal' && o.kind === 'state.noted' && phase === 'topic_reply_done') {
            return { kind: 'topic_reply_done' };
        }
        if (o.source === 'internal' && o.kind === 'state.noted' && phase === 'topic_left_done') {
            return { kind: 'topic_left_done' };
        }
    }

    for (const obs of env.inbox.current) {
        const o = obs as Observation;
        if (o.source === 'internal' && o.kind === 'state.noted') {
            const p = o.payload as { phase?: string; threadId?: string };
            if (p.phase === 'responder_reply_sent' && typeof p.threadId === 'string') {
                return { kind: 'reply_sent', threadId: p.threadId };
            }
        }
    }

    for (const obs of env.inbox.current) {
        const o = obs as Observation;
        if (o.source === 'conversation' && o.kind === 'topic.message.received') {
            const payload = o.payload as {
                kind?: string;
                topic?: { id?: string };
                message?: { id?: string; sequenceNumber?: number };
            };
            if (payload.kind === 'topic.message.received' && payload.topic?.id === DEMO_TOPIC_PHASE2_ID && payload.message) {
                const inboundMessageId =
                    typeof payload.message.id === 'string' ? payload.message.id : `seq-${payload.message.sequenceNumber ?? 0}`;
                log.info('conversation.topic_inbound', {
                    topicId: payload.topic.id,
                    sequenceNumber: payload.message.sequenceNumber,
                });
                return {
                    kind: 'topic_message',
                    topicId: DEMO_TOPIC_PHASE2_ID,
                    sequenceNumber: payload.message.sequenceNumber ?? 0,
                    inboundMessageId,
                };
            }
        }
    }

    for (const obs of env.inbox.current) {
        const o = obs as Observation;
        if (o.source === 'conversation' && o.kind === 'message.received') {
            const payload = o.payload as {
                kind?: string;
                message?: { id?: string; conversation?: { id?: string }; sequenceNumber?: number; senderAgentId?: string };
            };
            if (payload?.kind === 'message.received' && payload.message) {
                const msg = payload.message;
                const threadId = msg.conversation?.id;
                if (!threadId) {
                    continue;
                }
                const inboundMessageId = typeof msg.id === 'string' ? msg.id : `seq-${msg.sequenceNumber ?? 0}`;
                log.info('conversation.thread_inbound_received', {
                    threadId,
                    inboundMessageId,
                    sequenceNumber: msg.sequenceNumber ?? 0,
                    senderAgentId: msg.senderAgentId,
                });
                return {
                    kind: 'conversation',
                    threadId,
                    sequenceNumber: msg.sequenceNumber ?? 0,
                    inboundMessageId,
                };
            }
        }
    }

    return { kind: 'idle' };
}
