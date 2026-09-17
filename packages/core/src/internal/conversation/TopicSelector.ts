import { MemberIdSchema, type JsonValue } from '../../public-types/conversation/schemas.js';
import type { TopicSelector } from '../../public-types/conversation/types.js';
import type { ConversationTopicRecord } from '@a2arium/callagent-memory-engine';
import {
    TopicSelectorPolicyResultSchema,
    type TopicSelectorPolicyContext,
} from '../../public-types/conversation/selectorPolicy.js';
import { paramsHashFromJsonValue } from '../util/canonicalJson.js';
import type { TopicSelectorPolicyRegistry } from './TopicSelectorPolicyRegistry.js';

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

function broadcastRecipients(senderMemberId: string, members: TopicMemberRow[]): TopicMemberRow[] {
    const active = members.filter((m) => m.memberId !== senderMemberId);
    return [...active].sort(compareMembers);
}

export type ResolveTopicSelectorOpts = {
    tenantId: string;
    topicId: string;
    sequenceNumber: number;
    nowIso: string;
    policyRegistry: TopicSelectorPolicyRegistry;
};

export type TopicSelectorPolicyForTrace = {
    policyId: string;
    paramsHash?: string;
    outcome: 'selected' | 'abstained_fallback_broadcast';
};

export type TopicSelectorResolution =
    | {
          ok: true;
          recipients: TopicMemberRow[];
          nextRotationCursor: string | null;
          selectorPolicyForTrace?: TopicSelectorPolicyForTrace;
      }
    | {
          ok: false;
          error:
              | 'RecipientNotMember'
              | 'RecipientAmbiguous'
              | 'SelectorPolicyNotRegistered'
              | 'PolicyParamsInvalid'
              | 'PolicyInternalError';
      };

/**
 * Resolves recipients for a topic post. Excludes the sender seat by `memberId`.
 * `rotationCursor` is the last-delivered recipient `memberId` for round_robin (null = start from first active).
 */
export function resolveTopicSelector(
    selector: TopicSelector,
    senderMemberId: string,
    members: TopicMemberRow[],
    rotationCursor: string | null,
    opts: ResolveTopicSelectorOpts
): TopicSelectorResolution {
    if (selector.kind === 'broadcast') {
        const sorted = broadcastRecipients(senderMemberId, members);
        return { ok: true, recipients: sorted, nextRotationCursor: rotationCursor };
    }

    if (selector.kind === 'explicit_recipient') {
        const active = members.filter((m) => m.memberId !== senderMemberId);
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

    if (selector.kind === 'selector_policy') {
        const policy = opts.policyRegistry.resolve(selector.policyId);
        if (!policy) {
            return { ok: false, error: 'SelectorPolicyNotRegistered' };
        }
        let paramsForContext: unknown = selector.params;
        if (policy.paramsSchema) {
            const validated = policy.paramsSchema.safeParse(selector.params);
            if (!validated.success) {
                return { ok: false, error: 'PolicyParamsInvalid' };
            }
            paramsForContext = validated.data;
        }
        const active = members.filter((m) => m.memberId !== senderMemberId);
        const sorted = [...active].sort(compareMembers);
        if (sorted.length === 0) {
            return { ok: true, recipients: [], nextRotationCursor: rotationCursor };
        }
        const resolvedMembers = sorted.map((m) => ({
            agentId: m.agentId,
            memberId: MemberIdSchema.parse(m.memberId),
            role: m.role,
            sessionId: m.sessionId,
        }));
        const ctx: TopicSelectorPolicyContext = {
            tenantId: opts.tenantId,
            topicId: opts.topicId,
            senderMemberId: MemberIdSchema.parse(senderMemberId),
            members: resolvedMembers,
            rotationCursor,
            sequenceNumber: opts.sequenceNumber,
            params: paramsForContext as TopicSelectorPolicyContext['params'],
            nowIso: opts.nowIso,
        };
        let raw: unknown;
        try {
            raw = policy.select(ctx);
        } catch {
            return { ok: false, error: 'PolicyInternalError' };
        }
        const parsed = TopicSelectorPolicyResultSchema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, error: 'PolicyInternalError' };
        }
        const pr = parsed.data;
        const ph = paramsHashFromJsonValue(selector.params);
        if (pr.kind === 'rejected') {
            if (pr.error.type === 'PolicyAbstain') {
                return {
                    ok: true,
                    recipients: broadcastRecipients(senderMemberId, members),
                    nextRotationCursor: rotationCursor,
                    selectorPolicyForTrace: {
                        policyId: selector.policyId,
                        paramsHash: ph,
                        outcome: 'abstained_fallback_broadcast',
                    },
                };
            }
            if (pr.error.type === 'PolicyParamsInvalid') {
                return { ok: false, error: 'PolicyParamsInvalid' };
            }
            return { ok: false, error: 'PolicyInternalError' };
        }
        const byMember = new Map(members.map((m) => [m.memberId, m]));
        const recipients: TopicMemberRow[] = [];
        for (const r of pr.recipients) {
            const row = byMember.get(String(r.memberId));
            if (!row) {
                return { ok: false, error: 'PolicyInternalError' };
            }
            recipients.push(row);
        }
        return {
            ok: true,
            recipients,
            nextRotationCursor: pr.nextRotationCursor,
            selectorPolicyForTrace: {
                policyId: selector.policyId,
                paramsHash: ph,
                outcome: 'selected',
            },
        };
    }

    const ordered = broadcastRecipients(senderMemberId, members);
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
    if (k === 'selector_policy') {
        const d = record.defaultSelectorData;
        const policyId = typeof d['policyId'] === 'string' ? d['policyId'] : '';
        if (policyId.length > 0) {
            const params = d['params'];
            return {
                kind: 'selector_policy',
                policyId,
                ...(params !== undefined ? { params: params as JsonValue } : {}),
            };
        }
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
    if (selector.kind === 'selector_policy') {
        const data: Record<string, unknown> = { policyId: selector.policyId };
        if (selector.params !== undefined) {
            data['params'] = selector.params;
        }
        return { kind: 'selector_policy', data };
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
