import type {
    ConversationKind,
    ConversationMessageDeliveryRecord,
    ConversationMessageRecord,
    ConversationTopicInviteRecord,
    ConversationTopicMemberRecord,
    ConversationTopicRecord,
    ConversationTopicSweepRow,
    ConversationThreadRecord,
    ConversationThreadSweepRow,
    IWorkingMemorySessionStore,
    UpdateConversationThreadStatusInput,
    WMSessionSnapshot,
} from '@a2arium/callagent-memory-engine';
import { preserveConversationInboxForSnapshot } from '../loop/conversationInboxIdentity.js';
import {
    resolveOutboxDispatchContext,
    type OutboxDispatchContext,
} from '../eventbus/outboxDispatch.js';

export type OutboxEnqueuedRef = {
    outboxRowId: string;
    eventType: string;
    tenantId: string;
    key: string;
    traceId?: string;
    agentId?: string;
    token?: string;
};

export type { OutboxDispatchContext };

export class SessionManager {
    constructor(private readonly store?: IWorkingMemorySessionStore) { }

    private onOutboxEnqueued?: (ref: OutboxEnqueuedRef) => void | Promise<void>;

    setOnOutboxEnqueued(handler: (ref: OutboxEnqueuedRef) => void | Promise<void>): void {
        this.onOutboxEnqueued = handler;
    }

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

        const loaded = await this.store.getSessionSnapshot(params.tenantId, params.sessionId);
        const snapshotToWrite = preserveConversationInboxForSnapshot(
            params.snapshot,
            loaded?.snapshot as Record<string, unknown> | undefined
        );
        const paramsToWrite = { ...params, snapshot: snapshotToWrite };

        // Enforce WM snapshot size cap (bytes)
        try {
            const serialized = JSON.stringify(snapshotToWrite);
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

        const result = await this.store.writeSnapshotCAS(paramsToWrite);
        return result;
    }

    async enqueueOutbox(
        tenantId: string,
        topic: string,
        key: string,
        payload: Record<string, unknown>,
        dispatchContext?: OutboxDispatchContext
    ): Promise<{ id: string } | void> {
        if (!this.store) return;
        const result = await this.store.enqueueOutbox({ tenantId, topic, key, payload });
        if (result?.id && this.onOutboxEnqueued) {
            const ctx = resolveOutboxDispatchContext(payload, dispatchContext);
            await this.onOutboxEnqueued({
                outboxRowId: result.id,
                eventType: topic,
                tenantId,
                key,
                traceId: ctx.traceId,
                agentId: ctx.agentId,
                token: ctx.token,
            });
        }
        return result;
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
        expiresAt?: string | null;
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

    async updateConversationThreadStatus(params: UpdateConversationThreadStatusInput): Promise<void> {
        if (!this.store) {
            return;
        }
        await this.store.updateConversationThreadStatus(params);
    }

    async refreshConversationThreadExpiry(params: {
        tenantId: string;
        conversationId: string;
        expiresAt: string | null;
    }): Promise<void> {
        if (!this.store) {
            return;
        }
        await this.store.refreshConversationThreadExpiry(params);
    }

    async listConversationThreadsForSweep(params: {
        tenantId: string;
        mode: 'expireOpen' | 'archiveClosed';
        nowIso: string;
        closedBeforeIso?: string;
        limit: number;
    }): Promise<ConversationThreadSweepRow[]> {
        if (!this.store) {
            return [];
        }
        return this.store.listConversationThreadsForSweep(params);
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

    async listConversationTopicsForSweep(params: {
        tenantId: string;
        closedBeforeIso: string;
        limit: number;
    }): Promise<ConversationTopicSweepRow[]> {
        if (!this.store) {
            return [];
        }
        return this.store.listConversationTopicsForSweep(params);
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

    async findConversationTopicInviteByIdempotencyKey(
        params: Parameters<IWorkingMemorySessionStore['findConversationTopicInviteByIdempotencyKey']>[0]
    ): ReturnType<IWorkingMemorySessionStore['findConversationTopicInviteByIdempotencyKey']> {
        if (!this.store) {
            return Promise.resolve(null);
        }
        return this.store.findConversationTopicInviteByIdempotencyKey(params);
    }

    async getConversationTopicInvite(
        params: Parameters<IWorkingMemorySessionStore['getConversationTopicInvite']>[0]
    ): Promise<ConversationTopicInviteRecord | null> {
        if (!this.store) {
            return null;
        }
        return this.store.getConversationTopicInvite(params);
    }

    async consumeConversationTopicInvite(
        params: Parameters<IWorkingMemorySessionStore['consumeConversationTopicInvite']>[0]
    ): ReturnType<IWorkingMemorySessionStore['consumeConversationTopicInvite']> {
        if (!this.store) {
            return Promise.resolve(null);
        }
        return this.store.consumeConversationTopicInvite(params);
    }

    async declineConversationTopicInvite(
        params: Parameters<IWorkingMemorySessionStore['declineConversationTopicInvite']>[0]
    ): ReturnType<IWorkingMemorySessionStore['declineConversationTopicInvite']> {
        if (!this.store) {
            return Promise.resolve(null);
        }
        return this.store.declineConversationTopicInvite(params);
    }

    async listExpiredConversationTopicInvites(
        params: Parameters<IWorkingMemorySessionStore['listExpiredConversationTopicInvites']>[0]
    ): ReturnType<IWorkingMemorySessionStore['listExpiredConversationTopicInvites']> {
        if (!this.store) {
            return Promise.resolve([]);
        }
        return this.store.listExpiredConversationTopicInvites(params);
    }

    async listUndeliveredConversationTopicInvites(
        params: Parameters<IWorkingMemorySessionStore['listUndeliveredConversationTopicInvites']>[0]
    ): ReturnType<IWorkingMemorySessionStore['listUndeliveredConversationTopicInvites']> {
        if (!this.store) {
            return Promise.resolve([]);
        }
        return this.store.listUndeliveredConversationTopicInvites(params);
    }

    async markConversationTopicInviteDeliveryAttempt(
        params: Parameters<IWorkingMemorySessionStore['markConversationTopicInviteDeliveryAttempt']>[0]
    ): ReturnType<IWorkingMemorySessionStore['markConversationTopicInviteDeliveryAttempt']> {
        if (!this.store) {
            return Promise.resolve(0);
        }
        return this.store.markConversationTopicInviteDeliveryAttempt(params);
    }

    async markConversationTopicInviteDelivered(
        params: Parameters<IWorkingMemorySessionStore['markConversationTopicInviteDelivered']>[0]
    ): ReturnType<IWorkingMemorySessionStore['markConversationTopicInviteDelivered']> {
        if (!this.store) {
            return Promise.resolve();
        }
        return this.store.markConversationTopicInviteDelivered(params);
    }

    async setConversationTopicInviteDeliveryFailureReason(
        params: Parameters<IWorkingMemorySessionStore['setConversationTopicInviteDeliveryFailureReason']>[0]
    ): ReturnType<IWorkingMemorySessionStore['setConversationTopicInviteDeliveryFailureReason']> {
        if (!this.store) {
            return Promise.resolve();
        }
        return this.store.setConversationTopicInviteDeliveryFailureReason(params);
    }

    async recordConversationMessageDeliveries(
        params: Parameters<IWorkingMemorySessionStore['recordConversationMessageDeliveries']>[0]
    ): Promise<void> {
        if (!this.store) {
            return;
        }
        await this.store.recordConversationMessageDeliveries(params);
    }

    async updateConversationMessageDelivery(
        params: Parameters<IWorkingMemorySessionStore['updateConversationMessageDelivery']>[0]
    ): Promise<void> {
        if (!this.store) {
            return;
        }
        await this.store.updateConversationMessageDelivery(params);
    }

    async listConversationMessageDeliveries(
        params: Parameters<IWorkingMemorySessionStore['listConversationMessageDeliveries']>[0]
    ): Promise<ConversationMessageDeliveryRecord[]> {
        if (!this.store) {
            return [];
        }
        return this.store.listConversationMessageDeliveries(params);
    }

    async getDurableSubscriptionCursor(
        params: Parameters<IWorkingMemorySessionStore['getDurableSubscriptionCursor']>[0]
    ): ReturnType<IWorkingMemorySessionStore['getDurableSubscriptionCursor']> {
        if (!this.store) {
            return Promise.resolve(null);
        }
        return this.store.getDurableSubscriptionCursor(params);
    }

    async upsertDurableSubscriptionCursor(
        params: Parameters<IWorkingMemorySessionStore['upsertDurableSubscriptionCursor']>[0]
    ): ReturnType<IWorkingMemorySessionStore['upsertDurableSubscriptionCursor']> {
        if (!this.store) {
            return Promise.resolve();
        }
        return this.store.upsertDurableSubscriptionCursor(params);
    }

    async appendConversationDeadLetter(
        params: Parameters<IWorkingMemorySessionStore['appendConversationDeadLetter']>[0]
    ): ReturnType<IWorkingMemorySessionStore['appendConversationDeadLetter']> {
        if (!this.store) {
            return Promise.resolve();
        }
        return this.store.appendConversationDeadLetter(params);
    }
}
