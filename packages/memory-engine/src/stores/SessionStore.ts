export type WMSessionSnapshot = {
    wmVersion: bigint;
    snapshot: Record<string, unknown>;
    agentId: string;
    updatedAt: string; // ISO
};

export type ConversationThreadRecord = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
    participantAgentId: string;
    status: 'open' | 'closed' | 'archived';
    createdAt: string;
    updatedAt: string;
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
    speechAct: string;
    payload: Record<string, unknown>;
    correlationId?: string;
    idempotencyKey?: string;
    createdAt: string;
};

export type ConversationTopicRecord = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
    status: 'open' | 'closed' | 'archived';
    defaultSelectorKind: string;
    defaultSelectorData: Record<string, unknown>;
    /** Last-delivered recipient memberId for round_robin; null forces restart-from-first. */
    rotationCursor: string | null;
    createdAt: string;
    updatedAt: string;
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
    consumedAt: string | null;
};

export type ConversationMessageDeliveryStatus = 'delivered' | 'rejected' | 'queued';

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
    }): Promise<void>;
    createConversationThread(params: {
        tenantId: string;
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
    }): Promise<ConversationThreadRecord>;
    getConversationThread(params: {
        tenantId: string;
        conversationId: string;
    }): Promise<ConversationThreadRecord | null>;
    updateConversationThreadStatus(params: {
        tenantId: string;
        conversationId: string;
        status: 'open' | 'closed' | 'archived';
    }): Promise<void>;
    appendConversationMessage(params: {
        tenantId: string;
        conversationId: string;
        messageId: string;
        senderAgentId: string;
        senderMemberId: string;
        recipientAgentId: string | null;
        conversationKind: ConversationKind;
        selectorKind: string | null;
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
        patch: Partial<Pick<ConversationTopicRecord, 'status' | 'rotationCursor' | 'defaultSelectorKind' | 'defaultSelectorData'>>;
    }): Promise<void>;
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
    }): Promise<void>;
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
    } | null>;
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
    listConversationMessageDeliveries(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
    }): Promise<ConversationMessageDeliveryRecord[]>;
}
