import type { InternalTaskContext } from '../../loop/internalContext.js';
import type { FanoutSendReceipt, TopicPostOptions, TopicRef } from '../../public-types/conversation/types.js';

function resolvedMembersFromReceipt(
    receipt: FanoutSendReceipt
): Array<{ memberId: string; agentId: string }> {
    if (receipt.status === 'accepted') {
        return receipt.deliveries.map((d) => ({
            memberId: String(d.memberId),
            agentId: d.recipientAgentId,
        }));
    }
    if (receipt.status === 'partial') {
        const a = receipt.accepted.map((d) => ({
            memberId: String(d.memberId),
            agentId: d.recipientAgentId,
        }));
        const r = receipt.rejected.map((x) => ({
            memberId: String(x.memberId),
            agentId: x.recipientAgentId,
        }));
        return [...a, ...r];
    }
    return [];
}

function fanoutSummaryFromReceipt(receipt: FanoutSendReceipt): {
    accepted: number;
    rejected: number;
    queued: number;
    dedupeHits: number;
} {
    if (receipt.status === 'accepted') {
        return {
            accepted: receipt.deliveries.length,
            rejected: 0,
            queued: 0,
            dedupeHits: receipt.deliveries.filter((d) => d.dedupeHit).length,
        };
    }
    if (receipt.status === 'partial') {
        return {
            accepted: receipt.accepted.length,
            rejected: receipt.rejected.length,
            queued: 0,
            dedupeHits: receipt.accepted.filter((d) => d.dedupeHit).length,
        };
    }
    if (receipt.status === 'queued') {
        return { accepted: 0, rejected: 0, queued: 1, dedupeHits: 0 };
    }
    return { accepted: 0, rejected: 1, queued: 0, dedupeHits: 0 };
}

function firstSequenceNumber(receipt: FanoutSendReceipt): number | undefined {
    if (receipt.status === 'accepted' && receipt.deliveries.length > 0) {
        return receipt.deliveries[0]!.sequenceNumber;
    }
    if (receipt.status === 'partial' && receipt.accepted.length > 0) {
        return receipt.accepted[0]!.sequenceNumber;
    }
    return undefined;
}

function firstDedupeHit(receipt: FanoutSendReceipt): boolean | undefined {
    if (receipt.status === 'accepted' && receipt.deliveries.length > 0) {
        return receipt.deliveries[0]!.dedupeHit;
    }
    if (receipt.status === 'partial' && receipt.accepted.length > 0) {
        return receipt.accepted[0]!.dedupeHit;
    }
    return undefined;
}

/**
 * Stamps InternalTaskContext fields consumed by loopRunner when assembling TurnTrace for a topic `post`.
 * Selector kind falls back to `broadcast` when the call omitted `options.selector` (topic default applies at runtime).
 */
export function stampTopicPostTurnTrace(
    iCtx: InternalTaskContext,
    topic: TopicRef,
    options: TopicPostOptions | undefined,
    receipt: FanoutSendReceipt
): void {
    iCtx.__turnConversationSummary = { id: topic.id, kind: 'topic' };
    const selectorKind = options?.selector?.kind ?? 'broadcast';
    iCtx.__turnTopicSelectorDecision = {
        kind: selectorKind,
        resolvedMembers: resolvedMembersFromReceipt(receipt),
    };
    iCtx.__turnFanoutSummary = fanoutSummaryFromReceipt(receipt);
    const seq = firstSequenceNumber(receipt);
    if (seq !== undefined) {
        iCtx.__turnConversationSequenceNumber = seq;
    }
    const dedupe = firstDedupeHit(receipt);
    if (dedupe !== undefined) {
        iCtx.__turnConversationDedupeHit = dedupe;
    }
}
