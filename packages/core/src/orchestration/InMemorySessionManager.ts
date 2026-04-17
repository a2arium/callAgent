import type {
    ConversationKind,
    ConversationMessageDeliveryRecord,
    ConversationMessageRecord,
    ConversationTopicInviteRecord,
    ConversationTopicMemberRecord,
    ConversationTopicRecord,
    ConversationThreadRecord,
    IWorkingMemorySessionStore,
    WMSessionSnapshot,
} from '@a2arium/callagent-memory-engine';

/**
 * In-memory implementation of IWorkingMemorySessionStore for testing and CLI usage.
 *
 * WARNING: This is NOT suitable for production use. Data is stored in memory and will be
 * lost when the process terminates. For production deployments, use a database-backed
 * SessionStore (e.g., PrismaSessionStore).
 *
 * This implementation is automatically used by TaskEngine when no sessionStore is configured,
 * enabling A2A calls to work out-of-box in development and testing environments.
 */
export class InMemorySessionManager implements IWorkingMemorySessionStore {
    private snapshots = new Map<string, WMSessionSnapshot>();
    private events = new Map<string, Array<{
        eventId: string;
        seq: number;
        type: string;
        payload: Record<string, unknown>;
        createdAt: string;
    }>>();
    private outbox: Array<{ tenantId: string; topic: string; key: string; payload: Record<string, unknown> }> = [];
    private conversationThreads = new Map<string, ConversationThreadRecord>();
    private conversationMessages = new Map<string, ConversationMessageRecord[]>();
    private conversationTopics = new Map<string, ConversationTopicRecord>();
    private topicMembers = new Map<string, ConversationTopicMemberRecord[]>();
    private topicInvites = new Map<string, ConversationTopicInviteRecord>();
    private messageDeliveries = new Map<string, ConversationMessageDeliveryRecord[]>();

    async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        const key = `${tenantId}:${sessionId}`;
        const snapshot = this.snapshots.get(key) || null;

        return snapshot;
    }

    async writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint }> {
        const key = `${params.tenantId}:${params.sessionId}`;

        const current = this.snapshots.get(key);

        // Simple CAS check - in production this would be atomic at database level
        if (current && current.wmVersion !== params.expectedWmVersion) {
            throw new Error('WM_VERSION_CONFLICT');
        }

        const newVersion = (current?.wmVersion ?? BigInt(0)) + BigInt(1);

        this.snapshots.set(key, {
            wmVersion: newVersion,
            snapshot: params.snapshot,
            agentId: params.agentId,
            updatedAt: new Date().toISOString()
        });

        return { newVersion };
    }

    async appendEvent(params: {
        tenantId: string;
        sessionId: string;
        type: string;
        payload: Record<string, unknown>;
    }): Promise<{ eventId: string; seq: number }> {
        const key = `${params.tenantId}:${params.sessionId}`;
        const eventList = this.events.get(key) || [];

        const seq = eventList.length;
        const eventId = `evt_${Date.now()}_${seq}`;

        eventList.push({
            eventId,
            seq,
            type: params.type,
            payload: params.payload,
            createdAt: new Date().toISOString()
        });

        this.events.set(key, eventList);
        return { eventId, seq };
    }

    async listEventsSince(params: {
        tenantId: string;
        sessionId: string;
        sinceSeq: number;
    }): Promise<Array<{
        eventId: string;
        seq: number;
        type: string;
        payload: Record<string, unknown>;
        createdAt: string;
    }>> {
        const key = `${params.tenantId}:${params.sessionId}`;
        const eventList = this.events.get(key) || [];
        return eventList.filter(e => e.seq > params.sinceSeq);
    }

    async enqueueOutbox(params: {
        tenantId: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
    }): Promise<void> {
        // In production, this would persist to database for reliable delivery
        this.outbox.push(params);
    }

    async createConversationThread(params: {
        tenantId: string;
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
    }): Promise<ConversationThreadRecord> {
        const key = `${params.tenantId}:${params.conversationId}`;
        const now = new Date().toISOString();
        const existing = this.conversationThreads.get(key);
        if (existing) {
            return existing;
        }
        const created: ConversationThreadRecord = {
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            ownerAgentId: params.ownerAgentId,
            participantAgentId: params.participantAgentId,
            status: 'open',
            createdAt: now,
            updatedAt: now,
        };
        this.conversationThreads.set(key, created);
        return created;
    }

    async getConversationThread(params: {
        tenantId: string;
        conversationId: string;
    }): Promise<ConversationThreadRecord | null> {
        return this.conversationThreads.get(`${params.tenantId}:${params.conversationId}`) ?? null;
    }

    async updateConversationThreadStatus(params: {
        tenantId: string;
        conversationId: string;
        status: 'open' | 'closed' | 'archived';
    }): Promise<void> {
        const key = `${params.tenantId}:${params.conversationId}`;
        const existing = this.conversationThreads.get(key);
        if (!existing) {
            return;
        }
        this.conversationThreads.set(key, {
            ...existing,
            status: params.status,
            updatedAt: new Date().toISOString(),
        });
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
        const key = `${params.tenantId}:${params.conversationId}`;
        const current = this.conversationMessages.get(key) ?? [];
        const created: ConversationMessageRecord = {
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            sequenceNumber: current.length + 1,
            messageId: params.messageId,
            senderAgentId: params.senderAgentId,
            senderMemberId: params.senderMemberId,
            recipientAgentId: params.recipientAgentId,
            conversationKind: params.conversationKind,
            selectorKind: params.selectorKind,
            speechAct: params.speechAct,
            payload: params.payload,
            correlationId: params.correlationId,
            idempotencyKey: params.idempotencyKey,
            createdAt: new Date().toISOString(),
        };
        current.push(created);
        this.conversationMessages.set(key, current);
        return created;
    }

    async findConversationMessageByIdempotencyKey(params: {
        tenantId: string;
        conversationId: string;
        senderMemberId: string;
        idempotencyKey: string;
    }): Promise<ConversationMessageRecord | null> {
        const current = this.conversationMessages.get(`${params.tenantId}:${params.conversationId}`) ?? [];
        return (
            current.find(
                (msg) => msg.senderMemberId === params.senderMemberId && msg.idempotencyKey === params.idempotencyKey
            ) ?? null
        );
    }

    async listConversationMessages(params: {
        tenantId: string;
        conversationId: string;
        sinceSequence?: number;
    }): Promise<ConversationMessageRecord[]> {
        const current = this.conversationMessages.get(`${params.tenantId}:${params.conversationId}`) ?? [];
        const since = params.sinceSequence ?? 0;
        return current.filter((msg) => msg.sequenceNumber > since);
    }

    async createConversationTopic(params: {
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
    }): Promise<ConversationTopicRecord> {
        const key = `${params.tenantId}:${params.conversationId}`;
        const now = new Date().toISOString();
        const existing = this.conversationTopics.get(key);
        if (existing) {
            return existing;
        }
        const created: ConversationTopicRecord = {
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            ownerAgentId: params.ownerAgentId,
            status: 'open',
            defaultSelectorKind: params.defaultSelectorKind,
            defaultSelectorData: params.defaultSelectorData,
            rotationCursor: null,
            createdAt: now,
            updatedAt: now,
        };
        this.conversationTopics.set(key, created);
        const memberRows: ConversationTopicMemberRecord[] = params.members.map((m) => ({
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            memberId: m.memberId,
            agentId: m.agentId,
            role: m.role,
            sessionId: m.sessionId,
            registeredAt: m.registeredAt,
            leftAt: null,
        }));
        this.topicMembers.set(key, memberRows);
        return created;
    }

    async getConversationTopic(params: {
        tenantId: string;
        conversationId: string;
    }): Promise<ConversationTopicRecord | null> {
        return this.conversationTopics.get(`${params.tenantId}:${params.conversationId}`) ?? null;
    }

    async updateConversationTopic(params: {
        tenantId: string;
        conversationId: string;
        patch: Partial<Pick<ConversationTopicRecord, 'status' | 'rotationCursor' | 'defaultSelectorKind' | 'defaultSelectorData'>>;
    }): Promise<void> {
        const key = `${params.tenantId}:${params.conversationId}`;
        const existing = this.conversationTopics.get(key);
        if (!existing) {
            return;
        }
        this.conversationTopics.set(key, {
            ...existing,
            ...params.patch,
            updatedAt: new Date().toISOString(),
        });
    }

    async listConversationTopicMembers(params: {
        tenantId: string;
        conversationId: string;
        activeOnly?: boolean;
    }): Promise<ConversationTopicMemberRecord[]> {
        const rows = this.topicMembers.get(`${params.tenantId}:${params.conversationId}`) ?? [];
        const filtered = params.activeOnly ? rows.filter((r) => r.leftAt === null) : rows;
        return [...filtered].sort((a, b) => a.memberId.localeCompare(b.memberId));
    }

    async addConversationTopicMember(params: {
        tenantId: string;
        conversationId: string;
        memberId: string;
        agentId: string;
        role: 'owner' | 'participant';
        sessionId: string;
        registeredAt: string;
    }): Promise<void> {
        const key = `${params.tenantId}:${params.conversationId}`;
        const rows = this.topicMembers.get(key) ?? [];
        rows.push({
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            memberId: params.memberId,
            agentId: params.agentId,
            role: params.role,
            sessionId: params.sessionId,
            registeredAt: params.registeredAt,
            leftAt: null,
        });
        this.topicMembers.set(key, rows);
    }

    async leaveConversationTopicMember(params: {
        tenantId: string;
        conversationId: string;
        memberId: string;
        leftAt: string;
    }): Promise<void> {
        const key = `${params.tenantId}:${params.conversationId}`;
        const rows = this.topicMembers.get(key) ?? [];
        const next = rows.map((r) =>
            r.memberId === params.memberId && r.leftAt === null ? { ...r, leftAt: params.leftAt } : r
        );
        this.topicMembers.set(key, next);
    }

    async getConversationTopicMemberByMemberId(params: {
        tenantId: string;
        conversationId: string;
        memberId: string;
    }): Promise<ConversationTopicMemberRecord | null> {
        const rows = this.topicMembers.get(`${params.tenantId}:${params.conversationId}`) ?? [];
        return rows.find((r) => r.memberId === params.memberId && r.leftAt === null) ?? null;
    }

    async listConversationTopicMembersByAgent(params: {
        tenantId: string;
        conversationId: string;
        agentId: string;
        activeOnly?: boolean;
    }): Promise<ConversationTopicMemberRecord[]> {
        const rows = this.topicMembers.get(`${params.tenantId}:${params.conversationId}`) ?? [];
        const filtered = rows.filter((r) => r.agentId === params.agentId);
        if (params.activeOnly) {
            return filtered.filter((r) => r.leftAt === null);
        }
        return filtered;
    }

    async issueConversationTopicInvite(params: {
        tenantId: string;
        conversationId: string;
        token: string;
        inviteeAgentId: string;
        inviteeMemberId: string;
        role: 'owner' | 'participant';
        sessionIdOverride: string | null;
        issuedAt: string;
    }): Promise<void> {
        const rec: ConversationTopicInviteRecord = {
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            token: params.token,
            inviteeAgentId: params.inviteeAgentId,
            inviteeMemberId: params.inviteeMemberId,
            role: params.role,
            sessionIdOverride: params.sessionIdOverride,
            issuedAt: params.issuedAt,
            consumedAt: null,
        };
        this.topicInvites.set(params.token, rec);
    }

    async consumeConversationTopicInvite(params: {
        tenantId: string;
        token: string;
        consumedAt: string;
    }): Promise<{
        conversationId: string;
        inviteeAgentId: string;
        inviteeMemberId: string;
        role: 'owner' | 'participant';
        sessionIdOverride: string | null;
    } | null> {
        const rec = this.topicInvites.get(params.token);
        if (!rec || rec.tenantId !== params.tenantId || rec.consumedAt !== null) {
            return null;
        }
        this.topicInvites.set(params.token, { ...rec, consumedAt: params.consumedAt });
        return {
            conversationId: rec.conversationId,
            inviteeAgentId: rec.inviteeAgentId,
            inviteeMemberId: rec.inviteeMemberId,
            role: rec.role,
            sessionIdOverride: rec.sessionIdOverride,
        };
    }

    async recordConversationMessageDeliveries(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
        rows: Array<{
            memberId: string;
            recipientAgentId: string;
            sessionId: string;
            dedupeHit: boolean;
            status: ConversationMessageDeliveryRecord['status'];
            error: Record<string, unknown> | null;
            queuePosition: number | null;
        }>;
    }): Promise<void> {
        const key = `${params.tenantId}:${params.conversationId}:${params.sequenceNumber}`;
        const next: ConversationMessageDeliveryRecord[] = params.rows.map((r) => ({
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            sequenceNumber: params.sequenceNumber,
            memberId: r.memberId,
            recipientAgentId: r.recipientAgentId,
            sessionId: r.sessionId,
            dedupeHit: r.dedupeHit,
            status: r.status,
            error: r.error,
            queuePosition: r.queuePosition,
        }));
        this.messageDeliveries.set(key, next);
    }

    async listConversationMessageDeliveries(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
    }): Promise<ConversationMessageDeliveryRecord[]> {
        return this.messageDeliveries.get(`${params.tenantId}:${params.conversationId}:${params.sequenceNumber}`) ?? [];
    }

    // Helper method for testing/debugging (not part of interface)
    clear(): void {
        this.snapshots.clear();
        this.events.clear();
        this.outbox = [];
        this.conversationThreads.clear();
        this.conversationMessages.clear();
        this.conversationTopics.clear();
        this.topicMembers.clear();
        this.topicInvites.clear();
        this.messageDeliveries.clear();
    }

    // Helper to get all snapshots (for debugging)
    getAllSnapshots(): Map<string, WMSessionSnapshot> {
        return new Map(this.snapshots);
    }
}
