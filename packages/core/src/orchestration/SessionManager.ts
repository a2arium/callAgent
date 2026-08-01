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
    RunnableTurnRequest,
    RunnableTurnRequestCursor,
} from '@a2arium/callagent-memory-engine';
import { preserveConversationInboxForSnapshot } from '../loop/conversationInboxIdentity.js';
import {
    resolveOutboxDispatchContext,
    type OutboxDispatchContext,
} from '../eventbus/outboxDispatch.js';
import {
    addProcessedSegmentKey,
    currentSegmentIdempotencyKey,
    nextSegmentOutboxIdempotencyKey,
} from '../runtime/segmentProcessedKeys.js';
import {
    OperatorProjectionRepository,
    readProjectionWriteMode,
    type OperatorProjectionEvent,
} from '../operator/semanticProjection.js';
import {
    budgetErrorPayload,
    compactOperationalEventPayload,
    enforcePayloadBudget,
    measureJsonBytes,
    readEventPayloadMaxBytes,
    type PayloadBudgetCode,
} from '../operator/payloadBudget.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import { logger } from '@a2arium/callagent-utils';
import { randomUUID } from 'node:crypto';

const log = logger.createLogger({ prefix: 'SessionManager' });

export class SnapshotLimitError extends Error {
    public readonly code = 'LIMIT_WM_SNAPSHOT_TOO_LARGE';

    constructor(
        public readonly limitBytes: number,
        public readonly actualBytes: number
    ) {
        super('LIMIT_WM_SNAPSHOT_TOO_LARGE');
        this.name = 'SnapshotLimitError';
        Object.setPrototypeOf(this, SnapshotLimitError.prototype);
    }
}

export function isSnapshotLimitError(error: unknown): error is SnapshotLimitError {
    return error instanceof SnapshotLimitError || (
        !!error &&
        typeof error === 'object' &&
        (error as { code?: unknown }).code === 'LIMIT_WM_SNAPSHOT_TOO_LARGE'
    );
}

export type OutboxEnqueuedRef = {
    outboxRowId: string;
    eventType: string;
    tenantId: string;
    key: string;
    traceId?: string;
    agentId?: string;
    token?: string;
    deliveryScope: 'process' | 'shared';
    deliveryOwnerId?: string;
    payload: Record<string, unknown>;
};

export type { OutboxDispatchContext };

function readSnapshotAgentId(snapshot: Record<string, unknown> | undefined): string | undefined {
    const meta = snapshot?.meta;
    if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
        return undefined;
    }
    const agentId = (meta as Record<string, unknown>).agentId;
    return typeof agentId === 'string' ? agentId : undefined;
}

export class SessionManager {
    constructor(private readonly store?: IWorkingMemorySessionStore) { }

    supportsDurableTaskAdmission(): boolean {
        return this.store?.taskAdmissionCapabilities?.durablePersistence === true &&
            this.store.taskAdmissionCapabilities.runnableTurnRecovery === true &&
            typeof this.store.listRunnableTurnRequests === 'function';
    }

    private onOutboxEnqueued?: (ref: OutboxEnqueuedRef) => void | Promise<void>;
    private outboxDelivery: { scope: 'process' | 'shared'; ownerId?: string } = {
        scope: 'process',
        ownerId: `session-manager:${randomUUID()}`,
    };

    configureOutboxDelivery(params: { scope: 'process' | 'shared'; ownerId?: string }): void {
        if (params.scope === 'process' && !params.ownerId) {
            throw new Error('OUTBOX_PROCESS_OWNER_REQUIRED');
        }
        this.outboxDelivery = { ...params };
    }

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

    async loadForMutation(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        if (!this.store) return null;
        return this.store.getSessionSnapshotForMutation?.(tenantId, sessionId)
            ?? this.store.getSessionSnapshot(tenantId, sessionId);
    }

    async listRunnableTurnRequests(params: {
        cursor?: RunnableTurnRequestCursor;
        limit?: number;
    }): Promise<RunnableTurnRequest[]> {
        if (!this.store?.listRunnableTurnRequests) return [];
        return this.store.listRunnableTurnRequests({
            ...(params.cursor ? { cursor: params.cursor } : {}),
            limit: params.limit ?? 100,
        });
    }

    async appendEvent(tenantId: string, sessionId: string, type: string, payload: Record<string, unknown>) {
        if (!this.store) return { eventId: '', seq: 0 };
        const budget = enforcePayloadBudget(payload, {
            code: 'LIMIT_EVENT_PAYLOAD_TOO_LARGE',
            limitBytes: readEventPayloadMaxBytes(),
            summary: `Working-memory event "${type}" exceeded the configured payload budget.`,
        });
        defaultMetricsRegistry.setGauge('payload.event_size_bytes', budget.ok ? budget.sizeBytes : budget.actualBytes, {
            type,
        });
        if (!budget.ok) {
            defaultMetricsRegistry.increment('payload.budget_failure_total', {
                surface: 'wm_event',
                code: budget.code,
                type,
            });
        }
        const payloadToWrite = budget.ok ? budget.value : compactOperationalEventPayload(type, payload);
        const result = await this.store.appendEvent({ tenantId, sessionId, type, payload: payloadToWrite });
        await this.projectOperatorEvent({
            tenantId,
            sessionId,
            type,
            payload: payloadToWrite,
            eventId: result.eventId,
            seq: result.seq,
            createdAt: new Date(),
        });
        if (!budget.ok) {
            await this.appendBudgetExceededEvent({
                tenantId,
                sessionId,
                taskId: typeof payload.taskId === 'string' ? payload.taskId : sessionId,
                code: budget.code,
                message: budget.summary,
                limitBytes: budget.limitBytes,
                actualBytes: budget.actualBytes,
                fieldPath: budget.fieldPath,
                eventType: type,
            });
        }
        return result;
    }

    async appendBudgetExceededEvent(params: {
        tenantId: string;
        sessionId: string;
        taskId?: string;
        code: PayloadBudgetCode;
        message?: string;
        limitBytes: number;
        actualBytes?: number;
        fieldPath?: string;
        eventType?: string;
    }): Promise<{ eventId: string; seq: number } | undefined> {
        if (!this.store) return undefined;
        const budgetPayload = {
            taskId: params.taskId ?? params.sessionId,
            ...budgetErrorPayload({
                code: params.code,
                message: params.message,
                limitBytes: params.limitBytes,
                actualBytes: params.actualBytes,
                fieldPath: params.fieldPath,
                eventType: params.eventType,
            }),
        };
        const budgetEvent = await this.store.appendEvent({
            tenantId: params.tenantId,
            sessionId: params.sessionId,
            type: 'payload.budget_exceeded',
            payload: budgetPayload,
        });
        await this.projectOperatorEvent({
            tenantId: params.tenantId,
            sessionId: params.sessionId,
            type: 'payload.budget_exceeded',
            payload: budgetPayload,
            eventId: budgetEvent.eventId,
            seq: budgetEvent.seq,
            createdAt: new Date(),
        });
        return budgetEvent;
    }

    async appendIncidentEvent(params: {
        tenantId: string;
        sessionId: string;
        taskId?: string;
        operation: string;
        message: string;
        errorCode?: string;
        eventType?: string;
        surface?: string;
        providerRunId?: string;
        providerTaskRunId?: string;
        traceId?: string;
    }): Promise<{ eventId: string; seq: number } | undefined> {
        if (!this.store) return undefined;
        const payload = {
            taskId: params.taskId ?? params.sessionId,
            operation: params.operation,
            message: params.message,
            ...(params.errorCode ? { errorCode: params.errorCode } : {}),
            ...(params.eventType ? { eventType: params.eventType } : {}),
            ...(params.surface ? { surface: params.surface } : {}),
            ...(params.providerRunId ? { providerRunId: params.providerRunId } : {}),
            ...(params.providerTaskRunId ? { providerTaskRunId: params.providerTaskRunId } : {}),
            ...(params.traceId ? { traceId: params.traceId } : {}),
        };
        const event = await this.store.appendEvent({
            tenantId: params.tenantId,
            sessionId: params.sessionId,
            type: 'observability.incident',
            payload,
        });
        await this.projectOperatorEvent({
            tenantId: params.tenantId,
            sessionId: params.sessionId,
            type: 'observability.incident',
            payload,
            eventId: event.eventId,
            seq: event.seq,
            createdAt: new Date(),
        });
        return event;
    }

    private async projectOperatorEvent(event: OperatorProjectionEvent): Promise<void> {
        const mode = readProjectionWriteMode();
        if (mode === 'off') {
            return;
        }
        const prisma = (this.store as unknown as { prisma?: unknown } | undefined)?.prisma;
        if (!prisma) {
            return;
        }
        const projection = new OperatorProjectionRepository(prisma as never);
        if (mode === 'on') {
            await projection.projectEvent(event);
            return;
        }
        try {
            await projection.projectEvent(event);
        } catch (error) {
            log.warn('Operator semantic event projection failed', {
                tenantId: event.tenantId,
                sessionId: event.sessionId,
                type: event.type,
                message: error instanceof Error ? error.message : String(error),
            });
        }
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
        const preservedSnapshot = preserveConversationInboxForSnapshot(
            params.snapshot,
            loaded?.snapshot as Record<string, unknown> | undefined
        );
        const activeSegmentKey = currentSegmentIdempotencyKey();
        const snapshotToWrite = activeSegmentKey !== undefined
            ? addProcessedSegmentKey(preservedSnapshot, activeSegmentKey)
            : preservedSnapshot;
        const paramsToWrite = { ...params, snapshot: snapshotToWrite };

        // Enforce WM snapshot size cap (bytes)
        try {
            JSON.stringify(snapshotToWrite);
            const sizeBytes = measureJsonBytes(snapshotToWrite);
            defaultMetricsRegistry.setGauge('payload.snapshot_size_bytes', sizeBytes, {
                surface: 'wm_snapshot',
            });
            const envCap = Number(process.env.WM_SNAPSHOT_MAX_BYTES);
            const maxBytes = Number.isFinite(envCap) && envCap > 0 ? envCap : 2 * 1024 * 1024; // 2MB default cap
            if (sizeBytes > maxBytes) {
                defaultMetricsRegistry.increment('payload.budget_failure_total', {
                    surface: 'wm_snapshot',
                    code: 'LIMIT_WM_SNAPSHOT_TOO_LARGE',
                });
                await this.appendSnapshotLimitEvent({
                    tenantId: params.tenantId,
                    sessionId: params.sessionId,
                    limitBytes: maxBytes,
                    actualBytes: sizeBytes,
                });
                throw new SnapshotLimitError(maxBytes, sizeBytes);
            }
        } catch (e) {
            if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') throw e;
            // If snapshot isn't serializable, surface error
            throw new Error('WM_SNAPSHOT_SERIALIZE_FAILED');
        }

        const result = await this.store.writeSnapshotCAS(paramsToWrite);
        return result;
    }

    private async appendSnapshotLimitEvent(params: {
        tenantId: string;
        sessionId: string;
        limitBytes: number;
        actualBytes: number;
    }): Promise<void> {
        if (!this.store) return;
        try {
            const payload = {
                taskId: params.sessionId,
                code: 'LIMIT_WM_SNAPSHOT_TOO_LARGE',
                message: 'Working-memory snapshot exceeded the configured size limit.',
                limitBytes: params.limitBytes,
                actualBytes: params.actualBytes,
            };
            const event = await this.store.appendEvent({
                tenantId: params.tenantId,
                sessionId: params.sessionId,
                type: 'wm.snapshot_limit',
                payload,
            });
            await this.projectOperatorEvent({
                tenantId: params.tenantId,
                sessionId: params.sessionId,
                type: 'wm.snapshot_limit',
                payload,
                eventId: event.eventId,
                seq: event.seq,
                createdAt: new Date(),
            });
        } catch (error) {
            log.warn('Failed to record working-memory snapshot budget event', {
                tenantId: params.tenantId,
                sessionId: params.sessionId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async enqueueOutbox(
        tenantId: string,
        topic: string,
        key: string,
        payload: Record<string, unknown>,
        dispatchContext?: OutboxDispatchContext,
        idempotencyKey?: string
    ): Promise<{ id: string } | void> {
        if (!this.store) return;
        const enrichedPayload = await this.enrichOutboxPayload(tenantId, key, payload, dispatchContext);
        const result = await this.store.enqueueOutbox({
            tenantId,
            topic,
            key,
            payload: enrichedPayload,
            idempotencyKey: idempotencyKey ?? nextSegmentOutboxIdempotencyKey(topic),
            deliveryScope: this.outboxDelivery.scope,
            deliveryOwnerId: this.outboxDelivery.ownerId,
        });
        if (result?.id && this.onOutboxEnqueued) {
            const ctx = resolveOutboxDispatchContext(enrichedPayload, dispatchContext);
            await this.onOutboxEnqueued({
                outboxRowId: result.id,
                eventType: topic,
                tenantId,
                key,
                traceId: ctx.traceId,
                agentId: ctx.agentId,
                token: ctx.token,
                deliveryScope: this.outboxDelivery.scope,
                deliveryOwnerId: this.outboxDelivery.ownerId,
                payload: enrichedPayload,
            });
        }
        return result;
    }

    private async enrichOutboxPayload(
        tenantId: string,
        key: string,
        payload: Record<string, unknown>,
        dispatchContext?: OutboxDispatchContext
    ): Promise<Record<string, unknown>> {
        if (typeof payload.agentId === 'string' || dispatchContext?.agentId !== undefined) {
            return dispatchContext?.agentId !== undefined && typeof payload.agentId !== 'string'
                ? { ...payload, agentId: dispatchContext.agentId }
                : payload;
        }

        const taskId = typeof payload.taskId === 'string' ? payload.taskId : key;
        const snapshot = await this.load(tenantId, taskId).catch(() => null);
        const agentId =
            snapshot?.agentId ??
            readSnapshotAgentId(snapshot?.snapshot as Record<string, unknown> | undefined);

        return agentId !== undefined ? { ...payload, agentId } : payload;
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
