import type { Observation } from '../types/observation.js';
import type { ObservationInbox } from './types.js';
import { normalizeObservationInbox } from './types.js';

const DEFAULT_CONSUMED_DELIVERY_KEY_LIMIT = 1024;

/**
 * Stable key for a thread or topic inbound message observation in a member inbox.
 * Used to dedupe duplicate routes and to drop re-emitted conversation observations
 * after a turn has already consumed the delivery.
 */
export function conversationInboxDeliveryKey(o: Observation): string | undefined {
    if (o.source !== 'conversation') {
        return undefined;
    }
    const p = o.payload as
        | {
              kind?: string;
              message?: {
                  id: string;
                  conversation: { id: string; kind: 'thread' | 'topic' };
                  recipientAgentId: string;
                  recipientMemberId?: string;
              };
          }
        | undefined;
    if (!p?.message) {
        return undefined;
    }
    if (p.kind !== 'message.received' && p.kind !== 'topic.message.received') {
        return undefined;
    }
    const m = p.message;
    const recipientKey =
        m.recipientMemberId !== undefined && String(m.recipientMemberId).length > 0
            ? String(m.recipientMemberId)
            : m.recipientAgentId;
    return `${p.kind}|${m.id}|${m.conversation.id}|${m.conversation.kind}|${recipientKey}`;
}

export type TurnIncomingConversationMessageSummary = {
    id: string;
    conversationId: string;
    kind: 'thread' | 'topic';
    senderAgentId: string;
    recipientAgentId: string;
    senderMemberId?: string;
    recipientMemberId?: string;
};

/**
 * Build the same key as {@link conversationInboxDeliveryKey} from oneTurn's
 * `__turnIncomingConversationMessages` entries.
 */
export function conversationInboxDeliveryKeyFromTurnSummary(
    s: TurnIncomingConversationMessageSummary
): string {
    const payloadKind = s.kind === 'thread' ? 'message.received' : 'topic.message.received';
    const recipientKey =
        s.recipientMemberId !== undefined && String(s.recipientMemberId).length > 0
            ? String(s.recipientMemberId)
            : s.recipientAgentId;
    return `${payloadKind}|${s.id}|${s.conversationId}|${s.kind}|${recipientKey}`;
}

/**
 * True if the inbox already contains a conversation delivery with the same key
 * in `inbox.all` (durable list).
 */
export function inboxAllHasConversationDeliveryKey(inbox: ObservationInbox | undefined, key: string): boolean {
    const n = normalizeObservationInbox(inbox);
    for (const obs of n.all) {
        const k = conversationInboxDeliveryKey(obs as Observation);
        if (k === key) {
            return true;
        }
    }
    return false;
}

export function readConsumedConversationDeliveryKeysFromMeta(meta: unknown): ReadonlySet<string> {
    if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) {
        return new Set<string>();
    }
    const raw = (meta as { conversationConsumedDeliveryKeys?: unknown })
        .conversationConsumedDeliveryKeys;
    if (!Array.isArray(raw)) {
        return new Set<string>();
    }
    return new Set(raw.filter((key): key is string => typeof key === 'string' && key.length > 0));
}

export function writeConsumedConversationDeliveryKeysToMeta(
    meta: Record<string, unknown>,
    keys: ReadonlySet<string>,
    limit = DEFAULT_CONSUMED_DELIVERY_KEY_LIMIT
): Record<string, unknown> {
    const existing = readConsumedConversationDeliveryKeysFromMeta(meta);
    const merged = [...existing, ...keys];
    const unique = [...new Set(merged)].slice(-limit);
    return {
        ...meta,
        conversationConsumedDeliveryKeys: unique,
    };
}

export function filterInboxCurrentByConversationDeliveryKeys(
    inbox: ObservationInbox | undefined,
    keys: ReadonlySet<string>
): ObservationInbox {
    const normalized = normalizeObservationInbox(inbox);
    if (keys.size === 0) {
        return normalized;
    }
    normalized.current = normalized.current.filter((obs) => {
        const key = conversationInboxDeliveryKey(obs as Observation);
        return key === undefined || !keys.has(key);
    });
    return normalized;
}

export function preserveConversationInboxForSnapshot(
    candidateSnapshot: Record<string, unknown>,
    remoteSnapshot: Record<string, unknown> | undefined
): Record<string, unknown> {
    const remoteInbox = normalizeObservationInbox((remoteSnapshot as { inbox?: unknown } | undefined)?.inbox);
    const hasRemoteConversation = remoteInbox.all.some(isConversationObservation) ||
        remoteInbox.current.some(isConversationObservation);
    if (!hasRemoteConversation) {
        return candidateSnapshot;
    }

    const candidateInbox = normalizeObservationInbox((candidateSnapshot as { inbox?: unknown }).inbox);
    const candidateMeta = normalizeMeta(candidateSnapshot.meta);
    const remoteMeta = normalizeMeta(remoteSnapshot?.meta);
    const consumedKeys = new Set<string>([
        ...readConsumedConversationDeliveryKeysFromMeta(remoteMeta),
        ...readConsumedConversationDeliveryKeysFromMeta(candidateMeta),
    ]);

    const nextAll = [...candidateInbox.all];
    for (const obs of remoteInbox.all) {
        if (isConversationObservation(obs)) {
            appendObservationIfMissing(nextAll, obs);
        }
    }

    const nextCurrent = candidateInbox.current.filter((obs) => {
        if (!isConversationObservation(obs)) {
            return true;
        }
        const key = conversationInboxDeliveryKey(obs as Observation);
        return key === undefined || !consumedKeys.has(key);
    });
    for (const obs of remoteInbox.current) {
        if (!isConversationObservation(obs)) {
            continue;
        }
        const key = conversationInboxDeliveryKey(obs as Observation);
        if (key !== undefined && consumedKeys.has(key)) {
            continue;
        }
        appendObservationIfMissing(nextCurrent, obs);
    }

    const nextMeta = consumedKeys.size > 0
        ? writeConsumedConversationDeliveryKeysToMeta(candidateMeta, consumedKeys)
        : candidateMeta;

    return {
        ...candidateSnapshot,
        meta: nextMeta,
        inbox: {
            ...candidateInbox,
            all: nextAll,
            current: nextCurrent,
        },
    };
}

function normalizeMeta(meta: unknown): Record<string, unknown> {
    if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) {
        return {};
    }
    return { ...(meta as Record<string, unknown>) };
}

function isConversationObservation(obs: unknown): obs is Observation {
    return (obs as { source?: unknown } | undefined)?.source === 'conversation';
}

function appendObservationIfMissing(target: Observation[], obs: Observation): void {
    const key = conversationObservationMergeKey(obs);
    if (!target.some((existing) => conversationObservationMergeKey(existing) === key)) {
        target.push(obs);
    }
}

function conversationObservationMergeKey(obs: Observation): string {
    const key = conversationInboxDeliveryKey(obs);
    return key !== undefined ? `conversation-delivery:${key}` : `conversation-observation:${JSON.stringify(obs)}`;
}
