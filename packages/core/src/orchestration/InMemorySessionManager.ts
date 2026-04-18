import type {
    ConversationKind,
    ConversationMessageDeliveryRecord,
    ConversationMessageRecord,
    ConversationTopicInviteRecord,
    ConversationTopicMemberRecord,
    ConversationTopicRecord,
    ConversationThreadRecord,
    ConversationThreadSweepRow,
    ConversationTopicSweepRow,
    IWorkingMemorySessionStore,
    UpdateConversationThreadStatusInput,
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
    /** `${tenantId}|${conversationId}|${idempotencyKey}` → invite token */
    private topicInviteIdempotencyIndex = new Map<string, string>();
    private messageDeliveries = new Map<string, ConversationMessageDeliveryRecord[]>();
    private durableCursors = new Map<string, { sequenceNumber: number; updatedAt: string }>();

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
        expiresAt?: string | null;
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
            expiresAt: params.expiresAt ?? null,
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

    async updateConversationThreadStatus(params: UpdateConversationThreadStatusInput): Promise<void> {
        const key = `${params.tenantId}:${params.conversationId}`;
        const existing = this.conversationThreads.get(key);
        if (!existing) {
            return;
        }
        const now = new Date().toISOString();
        if (params.kind === 'close') {
            this.conversationThreads.set(key, {
                ...existing,
                status: 'closed',
                closedAt: params.closedAt,
                closeReason: params.closeReason,
                closeReasonText: params.closeReasonText ?? null,
                closedByAgentId: params.closedByAgentId ?? null,
                updatedAt: now,
            });
            return;
        }
        this.conversationThreads.set(key, {
            ...existing,
            status: 'archived',
            archivedAt: params.archivedAt,
            archivedByAgentId: params.archivedByAgentId ?? null,
            archivedReasonText: params.archivedReasonText ?? null,
            updatedAt: now,
        });
    }

    async refreshConversationThreadExpiry(params: {
        tenantId: string;
        conversationId: string;
        expiresAt: string | null;
    }): Promise<void> {
        const key = `${params.tenantId}:${params.conversationId}`;
        const existing = this.conversationThreads.get(key);
        if (!existing || existing.status !== 'open') {
            return;
        }
        this.conversationThreads.set(key, {
            ...existing,
            expiresAt: params.expiresAt,
            updatedAt: new Date().toISOString(),
        });
    }

    async listConversationThreadsForSweep(params: {
        tenantId: string;
        mode: 'expireOpen' | 'archiveClosed';
        nowIso: string;
        closedBeforeIso?: string;
        limit: number;
    }): Promise<ConversationThreadSweepRow[]> {
        const out: ConversationThreadSweepRow[] = [];
        const nowMs = Date.parse(params.nowIso);
        for (const t of this.conversationThreads.values()) {
            if (t.tenantId !== params.tenantId) {
                continue;
            }
            if (params.mode === 'expireOpen') {
                if (
                    t.status === 'open' &&
                    t.expiresAt != null &&
                    Date.parse(t.expiresAt) < nowMs
                ) {
                    out.push({
                        tenantId: t.tenantId,
                        conversationId: t.conversationId,
                        ownerAgentId: t.ownerAgentId,
                        participantAgentId: t.participantAgentId,
                    });
                }
            } else if (params.closedBeforeIso) {
                const beforeMs = Date.parse(params.closedBeforeIso);
                if (
                    t.status === 'closed' &&
                    t.closedAt != null &&
                    Date.parse(t.closedAt) < beforeMs
                ) {
                    out.push({
                        tenantId: t.tenantId,
                        conversationId: t.conversationId,
                        ownerAgentId: t.ownerAgentId,
                        participantAgentId: t.participantAgentId,
                    });
                }
            }
            if (out.length >= params.limit) {
                break;
            }
        }
        return out;
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
        selectorPolicyId?: string | null;
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
            selectorPolicyId: params.selectorPolicyId ?? null,
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
        stopPolicies: unknown[];
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
            stopPolicies: [...params.stopPolicies],
            rotationCursor: null,
            closedAt: null,
            closeReason: null,
            closeReasonText: null,
            closedByAgentId: null,
            closedByMemberId: null,
            archivedAt: null,
            archivedByAgentId: null,
            archivedByMemberId: null,
            archivedReasonText: null,
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

    async listConversationTopicsForSweep(params: {
        tenantId: string;
        closedBeforeIso: string;
        limit: number;
    }): Promise<ConversationTopicSweepRow[]> {
        const out: ConversationTopicSweepRow[] = [];
        const beforeMs = Date.parse(params.closedBeforeIso);
        for (const t of this.conversationTopics.values()) {
            if (t.tenantId !== params.tenantId) {
                continue;
            }
            if (
                t.status === 'closed' &&
                t.archivedAt == null &&
                t.closedAt != null &&
                Date.parse(t.closedAt) < beforeMs
            ) {
                out.push({
                    tenantId: t.tenantId,
                    conversationId: t.conversationId,
                    ownerAgentId: t.ownerAgentId,
                });
            }
            if (out.length >= params.limit) {
                break;
            }
        }
        return out;
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
        expiresAt: string;
        inviterAgentId: string;
        inviterMemberId: string;
        inviterSessionId: string;
        idempotencyKey: string | null;
        correlationId: string | null;
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
            expiresAt: params.expiresAt,
            inviterAgentId: params.inviterAgentId,
            inviterMemberId: params.inviterMemberId,
            inviterSessionId: params.inviterSessionId,
            consumedAt: null,
            declinedAt: null,
            declineReason: null,
            deliveryAttemptedAt: null,
            deliveredAt: null,
            deliveryAttempts: 0,
            deliveryFailureReason: null,
            idempotencyKey: params.idempotencyKey,
            correlationId: params.correlationId,
        };
        this.topicInvites.set(params.token, rec);
        if (params.idempotencyKey) {
            const ik = `${params.tenantId}|${params.conversationId}|${params.idempotencyKey}`;
            this.topicInviteIdempotencyIndex.set(ik, params.token);
        }
    }

    async findConversationTopicInviteByIdempotencyKey(params: {
        tenantId: string;
        conversationId: string;
        idempotencyKey: string;
    }): Promise<ConversationTopicInviteRecord | null> {
        const ik = `${params.tenantId}|${params.conversationId}|${params.idempotencyKey}`;
        const token = this.topicInviteIdempotencyIndex.get(ik);
        if (!token) {
            return null;
        }
        return this.getConversationTopicInvite({ tenantId: params.tenantId, token });
    }

    async getConversationTopicInvite(params: {
        tenantId: string;
        token: string;
    }): Promise<ConversationTopicInviteRecord | null> {
        const rec = this.topicInvites.get(params.token);
        if (!rec || rec.tenantId !== params.tenantId) {
            return null;
        }
        return {
            ...rec,
            idempotencyKey: rec.idempotencyKey ?? null,
            correlationId: rec.correlationId ?? null,
        };
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
        inviterAgentId: string;
        inviterMemberId: string;
        inviterSessionId: string;
    } | null> {
        const rec = this.topicInvites.get(params.token);
        if (!rec || rec.tenantId !== params.tenantId || rec.consumedAt !== null || rec.declinedAt !== null) {
            return null;
        }
        this.topicInvites.set(params.token, { ...rec, consumedAt: params.consumedAt });
        return {
            conversationId: rec.conversationId,
            inviteeAgentId: rec.inviteeAgentId,
            inviteeMemberId: rec.inviteeMemberId,
            role: rec.role,
            sessionIdOverride: rec.sessionIdOverride,
            inviterAgentId: rec.inviterAgentId,
            inviterMemberId: rec.inviterMemberId,
            inviterSessionId: rec.inviterSessionId,
        };
    }

    async declineConversationTopicInvite(params: {
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
    } | null> {
        const rec = this.topicInvites.get(params.token);
        if (!rec || rec.tenantId !== params.tenantId || rec.consumedAt !== null || rec.declinedAt !== null) {
            return null;
        }
        this.topicInvites.set(params.token, {
            ...rec,
            consumedAt: params.declinedAt,
            declinedAt: params.declinedAt,
            declineReason: params.reason,
        });
        return {
            conversationId: rec.conversationId,
            inviterAgentId: rec.inviterAgentId,
            inviterMemberId: rec.inviterMemberId,
            inviterSessionId: rec.inviterSessionId,
            inviteeAgentId: rec.inviteeAgentId,
            inviteeMemberId: rec.inviteeMemberId,
        };
    }

    async listExpiredConversationTopicInvites(params: {
        tenantId: string;
        nowIso: string;
        limit: number;
    }): Promise<ConversationTopicInviteRecord[]> {
        const nowMs = Date.parse(params.nowIso);
        const rows = Array.from(this.topicInvites.values())
            .filter(
                (r) =>
                    r.tenantId === params.tenantId &&
                    r.consumedAt === null &&
                    r.declinedAt === null &&
                    Date.parse(r.expiresAt) < nowMs
            )
            .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
            .slice(0, params.limit);
        return rows;
    }

    async listUndeliveredConversationTopicInvites(params: {
        tenantId: string;
        nowIso: string;
        limit: number;
    }): Promise<ConversationTopicInviteRecord[]> {
        const rows = Array.from(this.topicInvites.values())
            .filter(
                (r) =>
                    r.tenantId === params.tenantId &&
                    r.consumedAt === null &&
                    r.declinedAt === null &&
                    r.deliveredAt === null &&
                    Date.parse(r.expiresAt) >= Date.parse(params.nowIso)
            )
            .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
            .slice(0, params.limit);
        return rows;
    }

    async markConversationTopicInviteDeliveryAttempt(params: {
        tenantId: string;
        token: string;
        attemptedAt: string;
    }): Promise<number> {
        const rec = this.topicInvites.get(params.token);
        if (!rec || rec.tenantId !== params.tenantId) {
            return 0;
        }
        const nextAttempts = rec.deliveryAttempts + 1;
        this.topicInvites.set(params.token, {
            ...rec,
            deliveryAttemptedAt: params.attemptedAt,
            deliveryAttempts: nextAttempts,
        });
        return nextAttempts;
    }

    async markConversationTopicInviteDelivered(params: {
        tenantId: string;
        token: string;
        deliveredAt: string;
    }): Promise<void> {
        const rec = this.topicInvites.get(params.token);
        if (!rec || rec.tenantId !== params.tenantId) {
            return;
        }
        this.topicInvites.set(params.token, {
            ...rec,
            deliveredAt: params.deliveredAt,
            deliveryFailureReason: null,
        });
    }

    async setConversationTopicInviteDeliveryFailureReason(params: {
        tenantId: string;
        token: string;
        reason: string;
    }): Promise<void> {
        const rec = this.topicInvites.get(params.token);
        if (!rec || rec.tenantId !== params.tenantId) {
            return;
        }
        this.topicInvites.set(params.token, {
            ...rec,
            deliveryFailureReason: params.reason,
        });
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

    async getDurableSubscriptionCursor(params: {
        tenantId: string;
        streamId: string;
        consumerId: string;
    }): Promise<{ sequenceNumber: number; updatedAt: string } | null> {
        const key = `${params.tenantId}:${params.streamId}:${params.consumerId}`;
        return this.durableCursors.get(key) ?? null;
    }

    async upsertDurableSubscriptionCursor(params: {
        tenantId: string;
        streamId: string;
        consumerId: string;
        sequenceNumber: number;
        updatedAt: string;
    }): Promise<void> {
        const key = `${params.tenantId}:${params.streamId}:${params.consumerId}`;
        this.durableCursors.set(key, {
            sequenceNumber: params.sequenceNumber,
            updatedAt: params.updatedAt,
        });
    }

    async appendConversationDeadLetter(_params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
        consumerId: string;
        record: Record<string, unknown>;
        lastError: string;
        attempts: number;
        deadletteredAt: string;
    }): Promise<void> {
        // In-memory store discards DLQ rows (durable subscription tests use SQL store for persistence checks).
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
        this.durableCursors.clear();
    }

    // Helper to get all snapshots (for debugging)
    getAllSnapshots(): Map<string, WMSessionSnapshot> {
        return new Map(this.snapshots);
    }
}
