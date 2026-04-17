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
    const invitesInbox = [...(prev?.invitesInbox ?? [])];

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
        if (payload.kind === 'topic.invite.issued') {
            const id = payload.topic.id;
            const cur = topics[id] ?? {
                ref: payload.topic,
                status: 'open' as const,
                members: [],
                currentSelector: { kind: 'broadcast' as const },
            };
            const currentPending = [...(cur.pendingInvites ?? [])];
            const token = String(payload.token);
            const nextPending = currentPending.filter((p) => String(p.token) !== token);
            nextPending.push({
                token: payload.token,
                inviteeAgentId: payload.invitee.agentId,
                inviteeMemberId: payload.invitee.memberId,
                role: payload.invitee.role,
                expiresAt: payload.expiresAt,
            });
            nextPending.sort((a, b) => {
                if (a.expiresAt === b.expiresAt) {
                    return String(a.token).localeCompare(String(b.token));
                }
                return a.expiresAt.localeCompare(b.expiresAt);
            });
            topics[id] = { ...cur, pendingInvites: nextPending };
        }
        if (payload.kind === 'topic.invite.received') {
            const token = String(payload.token);
            const nextInbox = invitesInbox.filter((i) => String(i.token) !== token);
            nextInbox.push({
                topic: payload.topic,
                token: payload.token,
                inviterAgentId: payload.inviterAgentId,
                role: payload.role,
                inviteeMemberId: payload.inviteeMemberId,
                expiresAt: payload.expiresAt,
            });
            nextInbox.sort((a, b) => {
                if (a.expiresAt === b.expiresAt) {
                    return String(a.token).localeCompare(String(b.token));
                }
                return a.expiresAt.localeCompare(b.expiresAt);
            });
            invitesInbox.splice(0, invitesInbox.length, ...nextInbox);
        }
        if (
            payload.kind === 'topic.invite.accepted' ||
            payload.kind === 'topic.invite.declined' ||
            payload.kind === 'topic.invite.expired'
        ) {
            const id = payload.topic.id;
            const cur = topics[id];
            if (cur?.pendingInvites) {
                const token = String(payload.token);
                const nextPending = cur.pendingInvites.filter((p) => String(p.token) !== token);
                topics[id] = { ...cur, pendingInvites: nextPending };
            }
            const token = String(payload.token);
            const nextInbox = invitesInbox.filter((i) => String(i.token) !== token);
            invitesInbox.splice(0, invitesInbox.length, ...nextInbox);
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
                const cur =
                    threads[id] ??
                    ({
                        ref: payload.thread,
                        status: 'open' as const,
                        pendingOutgoing: false,
                    } as ConversationProjection['threads'][string]);
                threads[id] = {
                    ...cur,
                    status: 'closed',
                    closedAt: payload.ts,
                    closedReason: payload.closedReason,
                    closedReasonText: payload.reasonText,
                    closedByAgentId: payload.closedBy,
                };
            }
        }
        if (payload.kind === 'thread.archived') {
            const id = payload.thread.id;
            const cur = threads[id];
            if (cur) {
                threads[id] = {
                    ...cur,
                    status: 'archived',
                    archivedAt: payload.ts,
                    archivedByAgentId: payload.archivedBy,
                    archivedReasonText: payload.reasonText,
                };
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
                        ...(payload.threadExpiresAt !== undefined
                            ? { expiresAt: payload.threadExpiresAt }
                            : {}),
                    };
                }
            }
        }
    }

    const sortedThreads: ConversationProjection['threads'] = {};
    for (const key of Object.keys(threads).sort()) {
        sortedThreads[key] = threads[key]!;
    }

    return deepFreeze({
        threads: sortedThreads,
        topics,
        invitesInbox,
    }) as ConversationProjection;
}
