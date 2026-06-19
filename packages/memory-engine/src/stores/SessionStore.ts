import type {
    ConversationThreadRecord,
    ConversationThreadSweepRow,
    UpdateConversationThreadStatusInput,
} from '@a2arium/callagent-types';

export type {
    ConversationThreadCloseReason,
    ConversationThreadRecord,
    ConversationThreadSweepRow,
    UpdateConversationThreadStatusInput,
} from '@a2arium/callagent-types';

export type WMSessionSnapshot = {
    wmVersion: bigint;
    snapshot: Record<string, unknown>;
    agentId: string;
    updatedAt: string; // ISO
};

export type ConversationKind = 'thread' | 'topic';

export type ConversationMessageRecord = {
    tenantId: string;
    conversationId: string;
    sequenceNumber: number;
    messageId: string;
    senderAgentId: string;
    senderMemberId: string;
    recipientAgentId: string | null;
    conversationKind: ConversationKind;
    selectorKind: string | null;
    selectorPolicyId: string | null;
    speechAct: string;
    payload: Record<string, unknown>;
    correlationId?: string;
    idempotencyKey?: string;
    createdAt: string;
};

export type ConversationTopicCloseReason = 'explicit' | 'ttl' | 'archived';

export type ConversationTopicRecord = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
    status: 'open' | 'closed' | 'archived';
    defaultSelectorKind: string;
    defaultSelectorData: Record<string, unknown>;
    /** JSON-shaped stop policy rules (validated by core). */
    stopPolicies: unknown[];
    /** Last-delivered recipient memberId for round_robin; null forces restart-from-first. */
    rotationCursor: string | null;
    closedAt?: string | null;
    closeReason?: ConversationTopicCloseReason | null;
    closeReasonText?: string | null;
    closedByAgentId?: string | null;
    closedByMemberId?: string | null;
    archivedAt?: string | null;
    archivedByAgentId?: string | null;
    archivedByMemberId?: string | null;
    archivedReasonText?: string | null;
    createdAt: string;
    updatedAt: string;
};

/** Rows eligible for auto-archive sweep (closed, not yet archived, old enough). */
export type ConversationTopicSweepRow = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
};

export type ConversationTopicMemberRecord = {
    tenantId: string;
    conversationId: string;
    memberId: string;
    agentId: string;
    role: 'owner' | 'participant';
    sessionId: string;
    registeredAt: string;
    leftAt: string | null;
};

export type ConversationTopicInviteRecord = {
    tenantId: string;
    conversationId: string;
    token: string;
    inviteeAgentId: string;
    inviteeMemberId: string;
    role: 'owner' | 'participant';
    sessionIdOverride: string | null;
    issuedAt: string;
    expiresAt: string;
    inviterAgentId: string;
    inviterMemberId: string;
    inviterSessionId: string;
    consumedAt: string | null;
    declinedAt: string | null;
    declineReason: string | null;
    deliveryAttemptedAt: string | null;
    deliveredAt: string | null;
    deliveryAttempts: number;
    deliveryFailureReason: string | null;
    idempotencyKey: string | null;
    correlationId: string | null;
};

export type ConversationMessageDeliveryStatus =
    | 'delivered'
    | 'rejected'
    | 'queued'
    | 'buffered'
    | 'throttled'
    | 'paused'
    | 'dead-lettered';

export type ConversationMessageDeliveryRecord = {
    tenantId: string;
    conversationId: string;
    sequenceNumber: number;
    memberId: string;
    recipientAgentId: string;
    sessionId: string;
    dedupeHit: boolean;
    status: ConversationMessageDeliveryStatus;
    error: Record<string, unknown> | null;
    queuePosition: number | null;
};

export interface IWorkingMemorySessionStore {
    getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null>;
    writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint }>;
    appendEvent(params: {
        tenantId: string;
        sessionId: string;
        type: string;
        payload: Record<string, unknown>;
    }): Promise<{ eventId: string; seq: number }>;
    listEventsSince(params: { tenantId: string; sessionId: string; sinceSeq: number }): Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>>;
    enqueueOutbox(params: {
        tenantId: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
        idempotencyKey?: string;
    }): Promise<{ id: string } | void>;
    createConversationThread(params: {
        tenantId: string;
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
        expiresAt?: string | null;
    }): Promise<ConversationThreadRecord>;
    getConversationThread(params: {
        tenantId: string;
        conversationId: string;
    }): Promise<ConversationThreadRecord | null>;
    updateConversationThreadStatus(params: UpdateConversationThreadStatusInput): Promise<void>;
    refreshConversationThreadExpiry(params: {
        tenantId: string;
        conversationId: string;
        expiresAt: string | null;
    }): Promise<void>;
    listConversationThreadsForSweep(params: {
        tenantId: string;
        mode: 'expireOpen' | 'archiveClosed';
        nowIso: string;
        /** Required when `mode === 'archiveClosed'`: threads with `closed_at` strictly before this ISO are selected. */
        closedBeforeIso?: string;
        limit: number;
    }): Promise<ConversationThreadSweepRow[]>;
    appendConversationMessage(params: {
        tenantId: string;
        conversationId: string;
        messageId: string;
        senderAgentId: string;
        senderMemberId: string;
        recipientAgentId: string | null;
        conversationKind: ConversationKind;
        selectorKind: string | null;
        selectorPolicyId?: string | null;
        speechAct: string;
        payload: Record<string, unknown>;
        correlationId?: string;
        idempotencyKey?: string;
    }): Promise<ConversationMessageRecord>;
    findConversationMessageByIdempotencyKey(params: {
        tenantId: string;
        conversationId: string;
        senderMemberId: string;
        idempotencyKey: string;
    }): Promise<ConversationMessageRecord | null>;
    listConversationMessages(params: {
        tenantId: string;
        conversationId: string;
        sinceSequence?: number;
    }): Promise<ConversationMessageRecord[]>;
    createConversationTopic(params: {
        tenantId: string;
        conversationId: string;
        ownerAgentId: string;
        defaultSelectorKind: string;
        defaultSelectorData: Record<string, unknown>;
        stopPolicies: unknown[];
        members: Array<{
            memberId: string;
            agentId: string;
            role: 'owner' | 'participant';
            sessionId: string;
            registeredAt: string;
        }>;
    }): Promise<ConversationTopicRecord>;
    getConversationTopic(params: {
        tenantId: string;
        conversationId: string;
    }): Promise<ConversationTopicRecord | null>;
    updateConversationTopic(params: {
        tenantId: string;
        conversationId: string;
        patch: Partial<
            Pick<
                ConversationTopicRecord,
                | 'status'
                | 'rotationCursor'
                | 'defaultSelectorKind'
                | 'defaultSelectorData'
                | 'closedAt'
                | 'closeReason'
                | 'closeReasonText'
                | 'closedByAgentId'
                | 'closedByMemberId'
                | 'archivedAt'
                | 'archivedByAgentId'
                | 'archivedByMemberId'
                | 'archivedReasonText'
            >
        >;
    }): Promise<void>;
    listConversationTopicsForSweep(params: {
        tenantId: string;
        closedBeforeIso: string;
        limit: number;
    }): Promise<ConversationTopicSweepRow[]>;
    listConversationTopicMembers(params: {
        tenantId: string;
        conversationId: string;
        activeOnly?: boolean;
    }): Promise<ConversationTopicMemberRecord[]>;
    addConversationTopicMember(params: {
        tenantId: string;
        conversationId: string;
        memberId: string;
        agentId: string;
        role: 'owner' | 'participant';
        sessionId: string;
        registeredAt: string;
    }): Promise<void>;
    leaveConversationTopicMember(params: {
        tenantId: string;
        conversationId: string;
        memberId: string;
        leftAt: string;
    }): Promise<void>;
    getConversationTopicMemberByMemberId(params: {
        tenantId: string;
        conversationId: string;
        memberId: string;
    }): Promise<ConversationTopicMemberRecord | null>;
    listConversationTopicMembersByAgent(params: {
        tenantId: string;
        conversationId: string;
        agentId: string;
        activeOnly?: boolean;
    }): Promise<ConversationTopicMemberRecord[]>;
    issueConversationTopicInvite(params: {
        tenantId: string;
        conversationId: string;
        token: string;
        inviteeAgentId: string;
        inviteeMemberId: string;
        role: 'owner' | 'participant';
        sessionIdOverride: string | null;
        issuedAt: string;
        expiresAt: string;
        inviterAgentId: string;
        inviterMemberId: string;
        inviterSessionId: string;
        idempotencyKey: string | null;
        correlationId: string | null;
    }): Promise<void>;
    findConversationTopicInviteByIdempotencyKey(params: {
        tenantId: string;
        conversationId: string;
        idempotencyKey: string;
    }): Promise<ConversationTopicInviteRecord | null>;
    getConversationTopicInvite(params: {
        tenantId: string;
        token: string;
    }): Promise<ConversationTopicInviteRecord | null>;
    consumeConversationTopicInvite(params: {
        tenantId: string;
        token: string;
        consumedAt: string;
    }): Promise<{
        conversationId: string;
        inviteeAgentId: string;
        inviteeMemberId: string;
        role: 'owner' | 'participant';
        sessionIdOverride: string | null;
        inviterAgentId: string;
        inviterMemberId: string;
        inviterSessionId: string;
    } | null>;
    declineConversationTopicInvite(params: {
        tenantId: string;
        token: string;
        declinedAt: string;
        reason: string | null;
    }): Promise<{
        conversationId: string;
        inviterAgentId: string;
        inviterMemberId: string;
        inviterSessionId: string;
        inviteeAgentId: string;
        inviteeMemberId: string;
    } | null>;
    markConversationTopicInviteDeliveryAttempt(params: {
        tenantId: string;
        token: string;
        attemptedAt: string;
    }): Promise<number>;
    markConversationTopicInviteDelivered(params: {
        tenantId: string;
        token: string;
        deliveredAt: string;
    }): Promise<void>;
    setConversationTopicInviteDeliveryFailureReason(params: {
        tenantId: string;
        token: string;
        reason: string;
    }): Promise<void>;
    listExpiredConversationTopicInvites(params: {
        tenantId: string;
        nowIso: string;
        limit: number;
    }): Promise<ConversationTopicInviteRecord[]>;
    listUndeliveredConversationTopicInvites(params: {
        tenantId: string;
        nowIso: string;
        limit: number;
    }): Promise<ConversationTopicInviteRecord[]>;
    recordConversationMessageDeliveries(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
        rows: Array<{
            memberId: string;
            recipientAgentId: string;
            sessionId: string;
            dedupeHit: boolean;
            status: ConversationMessageDeliveryStatus;
            error: Record<string, unknown> | null;
            queuePosition: number | null;
        }>;
    }): Promise<void>;
    updateConversationMessageDelivery(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
        memberId: string;
        status: ConversationMessageDeliveryStatus;
        error?: Record<string, unknown> | null;
        queuePosition?: number | null;
    }): Promise<void>;
    listConversationMessageDeliveries(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
    }): Promise<ConversationMessageDeliveryRecord[]>;

    getDurableSubscriptionCursor(params: {
        tenantId: string;
        streamId: string;
        consumerId: string;
    }): Promise<{ sequenceNumber: number; updatedAt: string } | null>;

    upsertDurableSubscriptionCursor(params: {
        tenantId: string;
        streamId: string;
        consumerId: string;
        sequenceNumber: number;
        updatedAt: string;
    }): Promise<void>;

    appendConversationDeadLetter(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
        consumerId: string;
        record: Record<string, unknown>;
        lastError: string;
        attempts: number;
        deadletteredAt: string;
    }): Promise<void>;
}
