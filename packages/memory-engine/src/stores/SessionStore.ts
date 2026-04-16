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

export type ConversationMessageRecord = {
    tenantId: string;
    conversationId: string;
    sequenceNumber: number;
    messageId: string;
    senderAgentId: string;
    recipientAgentId: string;
    speechAct: string;
    payload: Record<string, unknown>;
    correlationId?: string;
    idempotencyKey?: string;
    createdAt: string;
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
        recipientAgentId: string;
        speechAct: string;
        payload: Record<string, unknown>;
        correlationId?: string;
        idempotencyKey?: string;
    }): Promise<ConversationMessageRecord>;
    findConversationMessageByIdempotencyKey(params: {
        tenantId: string;
        conversationId: string;
        senderAgentId: string;
        idempotencyKey: string;
    }): Promise<ConversationMessageRecord | null>;
    listConversationMessages(params: {
        tenantId: string;
        conversationId: string;
        sinceSequence?: number;
    }): Promise<ConversationMessageRecord[]>;
}


