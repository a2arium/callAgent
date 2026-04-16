import type { EnvironmentState, MemoryReader, Observation } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { Obs } from './types.js';

const log = logger.createLogger({ prefix: 'conversation-responder-agent' });

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
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
        if (o.source === 'conversation' && o.kind === 'message.received') {
            const payload = o.payload as {
                kind?: string;
                message?: { id?: string; conversation?: { id?: string }; sequenceNumber?: number; senderAgentId?: string };
            };
            if (payload.kind === 'message.received' && payload.message) {
                const msg = payload.message;
                const conv = msg.conversation;
                const threadId = conv?.id;
                if (!threadId) {
                    continue;
                }
                const inboundMessageId = typeof msg.id === 'string' ? msg.id : `seq-${msg.sequenceNumber ?? 0}`;
                log.info('conversation.inbound_received', {
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
