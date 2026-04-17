import type {
    ConversationKind,
    ConversationMessageDeliveryRecord,
    ConversationMessageRecord,
    ConversationTopicMemberRecord,
    ConversationTopicRecord,
    ConversationThreadRecord,
    IWorkingMemorySessionStore,
    WMSessionSnapshot,
} from '@a2arium/callagent-memory-engine';

export class SessionManager {
    constructor(private readonly store?: IWorkingMemorySessionStore) { }

    async load(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        if (!this.store) {
            return null;
        }
        const result = await this.store.getSessionSnapshot(tenantId, sessionId);
        return result;
    }

    async appendEvent(tenantId: string, sessionId: string, type: string, payload: Record<string, unknown>) {
        if (!this.store) return { eventId: '', seq: 0 };
        return this.store.appendEvent({ tenantId, sessionId, type, payload });
    }

    async saveSnapshot(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint } | null> {
        if (!this.store) {
            return null;
        }

        // Enforce WM snapshot size cap (bytes)
        try {
            const serialized = JSON.stringify(params.snapshot);
            const envCap = Number(process.env.WM_SNAPSHOT_MAX_BYTES);
            const maxBytes = Number.isFinite(envCap) && envCap > 0 ? envCap : 2 * 1024 * 1024; // 2MB default cap
            if (serialized.length > maxBytes) {
                throw new Error('LIMIT_WM_SNAPSHOT_TOO_LARGE');
            }
        } catch (e) {
            if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') throw e;
            // If snapshot isn't serializable, surface error
            throw new Error('WM_SNAPSHOT_SERIALIZE_FAILED');
        }

        const result = await this.store.writeSnapshotCAS(params);
        return result;
    }

    async enqueueOutbox(tenantId: string, topic: string, key: string, payload: Record<string, unknown>) {
        if (!this.store) return;
        await this.store.enqueueOutbox({ tenantId, topic, key, payload });
    }

    async listEventsSince(params: { tenantId: string; sessionId: string; sinceSeq: number }) {
        if (!this.store) return [] as Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>;
        return this.store.listEventsSince(params);
    }

    async createConversationThread(params: {
        tenantId: string;
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
    }): Promise<ConversationThreadRecord> {
        if (!this.store) {
            throw new Error('Session store is required for conversation threads');
        }
        return this.store.createConversationThread(params);
    }

    async getConversationThread(params: {
        tenantId: string;
        conversationId: string;
    }): Promise<ConversationThreadRecord | null> {
        if (!this.store) {
            return null;
        }
        return this.store.getConversationThread(params);
    }

    async updateConversationThreadStatus(params: {
        tenantId: string;
        conversationId: string;
        status: 'open' | 'closed' | 'archived';
    }): Promise<void> {
        if (!this.store) {
            return;
        }
        await this.store.updateConversationThreadStatus(params);
    }

    async appendConversationMessage(params: {
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
    }): Promise<ConversationMessageRecord> {
        if (!this.store) {
            throw new Error('Session store is required for conversation messages');
        }
        return this.store.appendConversationMessage(params);
    }

    async findConversationMessageByIdempotencyKey(params: {
        tenantId: string;
        conversationId: string;
        senderMemberId: string;
        idempotencyKey: string;
    }): Promise<ConversationMessageRecord | null> {
        if (!this.store) {
            return null;
        }
        return this.store.findConversationMessageByIdempotencyKey(params);
    }

    async listConversationMessages(params: {
        tenantId: string;
        conversationId: string;
        sinceSequence?: number;
    }): Promise<ConversationMessageRecord[]> {
        if (!this.store) {
            return [];
        }
        return this.store.listConversationMessages(params);
    }

    async createConversationTopic(params: Parameters<IWorkingMemorySessionStore['createConversationTopic']>[0]): Promise<ConversationTopicRecord> {
        if (!this.store) {
            throw new Error('Session store is required for conversation topics');
        }
        return this.store.createConversationTopic(params);
    }

    async getConversationTopic(params: Parameters<IWorkingMemorySessionStore['getConversationTopic']>[0]): Promise<ConversationTopicRecord | null> {
        if (!this.store) {
            return null;
        }
        return this.store.getConversationTopic(params);
    }

    async updateConversationTopic(params: Parameters<IWorkingMemorySessionStore['updateConversationTopic']>[0]): Promise<void> {
        if (!this.store) {
            return;
        }
        await this.store.updateConversationTopic(params);
    }

    async listConversationTopicMembers(
        params: Parameters<IWorkingMemorySessionStore['listConversationTopicMembers']>[0]
    ): Promise<ConversationTopicMemberRecord[]> {
        if (!this.store) {
            return [];
        }
        return this.store.listConversationTopicMembers(params);
    }

    async addConversationTopicMember(params: Parameters<IWorkingMemorySessionStore['addConversationTopicMember']>[0]): Promise<void> {
        if (!this.store) {
            throw new Error('Session store is required');
        }
        await this.store.addConversationTopicMember(params);
    }

    async leaveConversationTopicMember(params: Parameters<IWorkingMemorySessionStore['leaveConversationTopicMember']>[0]): Promise<void> {
        if (!this.store) {
            return;
        }
        await this.store.leaveConversationTopicMember(params);
    }

    async getConversationTopicMemberByMemberId(
        params: Parameters<IWorkingMemorySessionStore['getConversationTopicMemberByMemberId']>[0]
    ): Promise<ConversationTopicMemberRecord | null> {
        if (!this.store) {
            return null;
        }
        return this.store.getConversationTopicMemberByMemberId(params);
    }

    async listConversationTopicMembersByAgent(
        params: Parameters<IWorkingMemorySessionStore['listConversationTopicMembersByAgent']>[0]
    ): Promise<ConversationTopicMemberRecord[]> {
        if (!this.store) {
            return [];
        }
        return this.store.listConversationTopicMembersByAgent(params);
    }

    async issueConversationTopicInvite(params: Parameters<IWorkingMemorySessionStore['issueConversationTopicInvite']>[0]): Promise<void> {
        if (!this.store) {
            throw new Error('Session store is required');
        }
        await this.store.issueConversationTopicInvite(params);
    }

    async consumeConversationTopicInvite(
        params: Parameters<IWorkingMemorySessionStore['consumeConversationTopicInvite']>[0]
    ): ReturnType<IWorkingMemorySessionStore['consumeConversationTopicInvite']> {
        if (!this.store) {
            return Promise.resolve(null);
        }
        return this.store.consumeConversationTopicInvite(params);
    }

    async recordConversationMessageDeliveries(
        params: Parameters<IWorkingMemorySessionStore['recordConversationMessageDeliveries']>[0]
    ): Promise<void> {
        if (!this.store) {
            return;
        }
        await this.store.recordConversationMessageDeliveries(params);
    }

    async listConversationMessageDeliveries(
        params: Parameters<IWorkingMemorySessionStore['listConversationMessageDeliveries']>[0]
    ): Promise<ConversationMessageDeliveryRecord[]> {
        if (!this.store) {
            return [];
        }
        return this.store.listConversationMessageDeliveries(params);
    }
}


