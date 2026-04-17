import type { ConversationProjection } from '../../public-types/conversation/projection.js';
import type { Observation } from '../../types/observation.js';

function deepFreeze<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Object.isFrozen(obj)) {
        return obj;
    }
    Object.freeze(obj);
    for (const key of Object.keys(obj as object)) {
        const v = (obj as Record<string, unknown>)[key];
        if (v && typeof v === 'object' && !Object.isFrozen(v)) {
            deepFreeze(v);
        }
    }
    return obj;
}

/**
 * Deterministic fold of conversation observations into `M.memory.conversation`.
 * Reads only the provided observations + previous projection.
 * Returns a deep-frozen object suitable for exposing to Policy as read-only.
 */
export function reduceConversationProjection(
    prev: ConversationProjection | undefined,
    observations: Observation[]
): ConversationProjection {
    const threads = { ...(prev?.threads ?? {}) };
    const topics = { ...(prev?.topics ?? {}) };

    for (const obs of observations) {
        if (obs.source !== 'conversation') {
            continue;
        }
        const payload = obs.payload;
        if (payload.kind === 'message.received') {
            const id = payload.message.conversation.id;
            const ref = payload.message.conversation;
            if (ref.kind === 'thread') {
                const cur = threads[id] ?? {
                    ref,
                    status: 'open' as const,
                    pendingOutgoing: false,
                };
                threads[id] = {
                    ...cur,
                    lastInboundSequence: payload.message.sequenceNumber,
                };
            }
        }
        if (payload.kind === 'topic.message.received') {
            const id = payload.topic.id;
            const cur =
                topics[id] ??
                ({
                    ref: payload.topic,
                    status: 'open' as const,
                    members: [],
                    currentSelector: payload.selector,
                } as ConversationProjection['topics'][string]);
            topics[id] = {
                ...cur,
                lastInboundSequence: payload.message.sequenceNumber,
                currentSelector: payload.selector,
            };
        }
        if (payload.kind === 'delivery.failed') {
            const id = payload.thread.id;
            const cur = threads[id];
            if (cur) {
                threads[id] = { ...cur, pendingOutgoing: false };
            }
        }
        if (payload.kind === 'topic.member.joined') {
            const id = payload.topic.id;
            const cur = topics[id] ?? {
                ref: payload.topic,
                status: 'open' as const,
                members: [],
                currentSelector: { kind: 'broadcast' as const },
            };
            const mid = String(payload.member.memberId);
            const members = [...cur.members.filter((m) => m.memberId !== mid)];
            members.push({
                agentId: payload.member.agentId,
                memberId: mid,
                role: payload.member.role,
            });
            members.sort((a, b) => a.memberId.localeCompare(b.memberId));
            topics[id] = { ...cur, members };
        }
        if (payload.kind === 'topic.member.left') {
            const id = payload.topic.id;
            const cur = topics[id];
            if (cur) {
                const mid = String(payload.memberId);
                topics[id] = {
                    ...cur,
                    members: cur.members.filter((m) => m.memberId !== mid),
                };
            }
        }
        if (payload.kind === 'topic.closed' || payload.kind === 'thread.closed') {
            if (payload.kind === 'topic.closed') {
                const id = payload.topic.id;
                const cur = topics[id];
                if (cur) {
                    topics[id] = { ...cur, status: 'closed' };
                }
            } else {
                const id = payload.thread.id;
                const cur = threads[id];
                if (cur) {
                    threads[id] = { ...cur, status: 'closed' };
                }
            }
        }
        if (payload.kind === 'outbound.committed') {
            const ref = payload.ref;
            if (ref.kind === 'topic') {
                const id = ref.id;
                const cur = topics[id];
                if (cur) {
                    topics[id] = {
                        ...cur,
                        lastOutboundSequence: payload.sequenceNumber,
                    };
                }
            } else {
                const id = ref.id;
                const cur = threads[id];
                if (cur) {
                    threads[id] = {
                        ...cur,
                        lastOutboundSequence: payload.sequenceNumber,
                        pendingOutgoing: false,
                    };
                }
            }
        }
    }

    return deepFreeze({
        threads,
        topics,
    }) as ConversationProjection;
}
