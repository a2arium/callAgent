import { MemberIdSchema } from '../../public-types/conversation/schemas.js';
import type { TopicSelector } from '../../public-types/conversation/types.js';
import type { ConversationTopicRecord } from '@a2arium/callagent-memory-engine';

export type TopicMemberRow = {
    memberId: string;
    agentId: string;
    role: 'owner' | 'participant';
    registeredAt: string;
    sessionId: string;
};

/** Deterministic ordering: role asc, registeredAt asc, memberId asc. */
function compareMembers(a: TopicMemberRow, b: TopicMemberRow): number {
    const roleCmp = a.role.localeCompare(b.role);
    if (roleCmp !== 0) {
        return roleCmp;
    }
    const tCmp = a.registeredAt.localeCompare(b.registeredAt);
    if (tCmp !== 0) {
        return tCmp;
    }
    return a.memberId.localeCompare(b.memberId);
}

export type TopicSelectorResolution =
    | { ok: true; recipients: TopicMemberRow[]; nextRotationCursor: string | null }
    | { ok: false; error: 'RecipientNotMember' | 'RecipientAmbiguous' };

/**
 * Resolves recipients for a topic post. Excludes the sender seat by `memberId`.
 * `rotationCursor` is the last-delivered recipient `memberId` for round_robin (null = start from first active).
 */
export function resolveTopicSelector(
    selector: TopicSelector,
    senderMemberId: string,
    members: TopicMemberRow[],
    rotationCursor: string | null
): TopicSelectorResolution {
    const active = members.filter((m) => m.memberId !== senderMemberId);

    if (selector.kind === 'broadcast') {
        const sorted = [...active].sort(compareMembers);
        return { ok: true, recipients: sorted, nextRotationCursor: rotationCursor };
    }

    if (selector.kind === 'explicit_recipient') {
        const r = selector.recipient;
        if (r.by === 'memberId') {
            const hit = active.find((m) => m.memberId === r.memberId);
            if (!hit) {
                return { ok: false, error: 'RecipientNotMember' };
            }
            return { ok: true, recipients: [hit], nextRotationCursor: rotationCursor };
        }
        const matches = active.filter((m) => m.agentId === r.agentId);
        if (matches.length === 0) {
            return { ok: false, error: 'RecipientNotMember' };
        }
        if (matches.length > 1) {
            return { ok: false, error: 'RecipientAmbiguous' };
        }
        return { ok: true, recipients: [matches[0]!], nextRotationCursor: rotationCursor };
    }

    const ordered = [...active].sort((a, b) => {
        const t = a.registeredAt.localeCompare(b.registeredAt);
        if (t !== 0) {
            return t;
        }
        return a.memberId.localeCompare(b.memberId);
    });
    if (ordered.length === 0) {
        return { ok: true, recipients: [], nextRotationCursor: rotationCursor };
    }

    let startIdx = 0;
    if (rotationCursor != null && rotationCursor.length > 0) {
        const cursorIdx = ordered.findIndex((m) => m.memberId === rotationCursor);
        if (cursorIdx >= 0) {
            startIdx = (cursorIdx + 1) % ordered.length;
        } else {
            startIdx = 0;
        }
    }
    const chosen = ordered[startIdx]!;
    return { ok: true, recipients: [chosen], nextRotationCursor: chosen.memberId };
}

export function topicSelectorFromRecord(record: ConversationTopicRecord): TopicSelector {
    const k = record.defaultSelectorKind;
    if (k === 'broadcast') {
        return { kind: 'broadcast' };
    }
    if (k === 'round_robin') {
        return { kind: 'round_robin' };
    }
    if (k === 'explicit_recipient') {
        const d = record.defaultSelectorData;
        const legacy = d['recipientAgentId'];
        if (typeof legacy === 'string' && legacy.length > 0) {
            return { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: legacy } };
        }
        const rec = d['recipient'] as Record<string, unknown> | undefined;
        if (rec && rec['by'] === 'agentId' && typeof rec['agentId'] === 'string') {
            return { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: rec['agentId'] } };
        }
        if (rec && rec['by'] === 'memberId' && typeof rec['memberId'] === 'string') {
            return {
                kind: 'explicit_recipient',
                recipient: { by: 'memberId', memberId: MemberIdSchema.parse(String(rec['memberId'])) },
            };
        }
    }
    return { kind: 'broadcast' };
}

export function topicSelectorToStorage(selector: TopicSelector): { kind: string; data: Record<string, unknown> } {
    if (selector.kind === 'broadcast') {
        return { kind: 'broadcast', data: {} };
    }
    if (selector.kind === 'round_robin') {
        return { kind: 'round_robin', data: {} };
    }
    const r = selector.recipient;
    if (r.by === 'agentId') {
        return {
            kind: 'explicit_recipient',
            data: { recipient: { by: 'agentId', agentId: r.agentId } },
        };
    }
    return {
        kind: 'explicit_recipient',
        data: { recipient: { by: 'memberId', memberId: r.memberId } },
    };
}
