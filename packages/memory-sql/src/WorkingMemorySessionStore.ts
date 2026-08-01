import { PrismaClient, Prisma } from './generated/prisma/index.js';
import type { PrismaClient as PrismaClientType } from './generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { logger } from '@a2arium/callagent-utils';
import { validatePgEnvironment, dumpPgEnvironment } from './pgEnvValidator.js';
import { getSafePgConfig } from './safePool.js';
import type {
    ConversationThreadRecord,
    ConversationThreadSweepRow,
    UpdateConversationThreadStatusInput,
} from '@a2arium/callagent-types';
import { WorkingMemoryVersionConflictError } from '@a2arium/callagent-types/working-memory-version-conflict';

export type SessionSnapshot = {
    exists?: boolean;
    wmVersion: bigint;
    snapshot: Record<string, unknown>;
    agentId: string;
    updatedAt: string;
    storageNow?: string;
};

export type RunnableTurnRequest = {
    tenantId: string;
    sessionId: string;
    agentId: string;
    updatedAt: string;
    createdAt: string;
    generation: string;
    deliveryKey: string;
    runtimeSurface: 'direct' | 'in_process' | 'hatchet';
};

export type RunnableTurnRequestCursor = {
    updatedAt: string;
    tenantId: string;
    sessionId: string;
};

type ConversationKind = 'thread' | 'topic';

type ConversationMessageRecord = {
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

type ConversationTopicCloseReason = 'explicit' | 'ttl' | 'archived';

type ConversationTopicRecord = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
    status: 'open' | 'closed' | 'archived';
    defaultSelectorKind: string;
    defaultSelectorData: Record<string, unknown>;
    stopPolicies: unknown[];
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

type ConversationTopicSweepRow = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
};

type ConversationTopicMemberRecord = {
    tenantId: string;
    conversationId: string;
    memberId: string;
    agentId: string;
    role: 'owner' | 'participant';
    sessionId: string;
    registeredAt: string;
    leftAt: string | null;
};

type ConversationTopicInviteRecord = {
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

type ConversationMessageDeliveryRecord = {
    tenantId: string;
    conversationId: string;
    sequenceNumber: number;
    memberId: string;
    recipientAgentId: string;
    sessionId: string;
    dedupeHit: boolean;
    status: 'delivered' | 'rejected' | 'queued' | 'buffered' | 'throttled' | 'paused' | 'dead-lettered';
    error: Record<string, unknown> | null;
    queuePosition: number | null;
};

function isPrismaErrorCode(error: unknown, code: string): boolean {
    return error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === code;
}

function mapConversationTopicInviteRow(row: Record<string, unknown>): ConversationTopicInviteRecord {
    const inviteeMemberId = row.invitee_member_id == null ? String(row.invitee_agent_id) : String(row.invitee_member_id);
    return {
        token: String(row.token),
        tenantId: String(row.tenant_id),
        conversationId: String(row.conversation_id),
        inviteeAgentId: String(row.invitee_agent_id),
        inviteeMemberId,
        role: String(row.role) as 'owner' | 'participant',
        sessionIdOverride: row.session_id_override == null ? null : String(row.session_id_override),
        issuedAt: new Date(String(row.issued_at)).toISOString(),
        expiresAt: new Date(String(row.expires_at)).toISOString(),
        inviterAgentId: String(row.inviter_agent_id),
        inviterMemberId: String(row.inviter_member_id),
        inviterSessionId: String(row.inviter_session_id),
        consumedAt: row.consumed_at == null ? null : new Date(String(row.consumed_at)).toISOString(),
        declinedAt: row.declined_at == null ? null : new Date(String(row.declined_at)).toISOString(),
        declineReason: row.decline_reason == null ? null : String(row.decline_reason),
        deliveryAttemptedAt: row.delivery_attempted_at == null ? null : new Date(String(row.delivery_attempted_at)).toISOString(),
        deliveredAt: row.delivered_at == null ? null : new Date(String(row.delivered_at)).toISOString(),
        deliveryAttempts: Number(row.delivery_attempts ?? 0),
        deliveryFailureReason: row.delivery_failure_reason == null ? null : String(row.delivery_failure_reason),
        idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
        correlationId: row.correlation_id == null ? null : String(row.correlation_id),
    };
}

export class WorkingMemorySessionStore {
    readonly taskAdmissionCapabilities = {
        durablePersistence: true,
        runnableTurnRecovery: true,
    } as const;
    private static globalPrisma: PrismaClientType | null = null;
    private readonly prisma: PrismaClientType;
    private readonly ownsPrisma: boolean;
    private readonly log = logger.createLogger({ prefix: 'WMSessionStore' });
    private connecting: Promise<void> | null = null;

    constructor(prisma?: PrismaClientType) {
        if (prisma) {
            this.prisma = prisma;
            this.ownsPrisma = false;
        } else {
            // Use global singleton if available, otherwise create it
            if (!WorkingMemorySessionStore.globalPrisma) {
                const dbUrl = process.env.MEMORY_DATABASE_URL;
                if (!dbUrl) {
                    throw new Error('WorkingMemorySessionStore: MEMORY_DATABASE_URL environment variable is required when no PrismaClient is provided.');
                }

                if (typeof dbUrl !== 'string') {
                    throw new Error(`Invalid type for MEMORY_DATABASE_URL in WorkingMemorySessionStore: expected string, received ${typeof dbUrl}`);
                }

                // Validate ALL pg-related env vars before creating the pool.
                // This catches the case where PGUSER/PGDATABASE/etc. is an Object.
                dumpPgEnvironment('WorkingMemorySessionStore');
                validatePgEnvironment('WorkingMemorySessionStore');

                WorkingMemorySessionStore.globalPrisma = new (PrismaClient as any)({
                    adapter: new PrismaPg(getSafePgConfig(dbUrl))
                });
            }
            this.prisma = WorkingMemorySessionStore.globalPrisma!;
            this.ownsPrisma = false; // We don't own the global singleton
        }
    }

    private async ensureConnected(): Promise<void> {
        if (this.connecting) {
            await this.connecting;
            return;
        }
        this.connecting = this.prisma.$connect().catch((err: any) => {
            // Reset so a later call can retry
            this.connecting = null;
            throw err;
        });
        try {
            await this.connecting;
        } finally {
            this.connecting = null;
        }
    }

    private async runWithReconnect<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (error instanceof Error && error.message.includes('Engine is not yet connected')) {
                await this.prisma.$connect();
                return await operation();
            }
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.ownsPrisma) await this.prisma.$disconnect();
    }

    // Back-compat alias for runner clean shutdown
    async close(): Promise<void> {
        await this.disconnect();
    }

    /** Composition-root access to the underlying Prisma client (worker / driver bootstrap). */
    getPrismaClient(): PrismaClientType {
        return this.prisma;
    }

    /**
     * Establish a connection immediately so callers can detect connectivity issues early.
     */
    async connect(): Promise<void> {
        await this.ensureConnected();
    }

    async getSessionSnapshot(tenantId: string, sessionId: string): Promise<SessionSnapshot | null> {
        await this.ensureConnected();
        const rec = await this.runWithReconnect(() => this.prisma.wMSession.findUnique({
            where: { tenantId_sessionId: { tenantId, sessionId } }
        })) as any;
        if (!rec) {
            this.log.debug?.('getSessionSnapshot: not found', { tenantId, sessionId });
            return null;
        }

        // DEBUG: Deep log for diagnosis
        if ((rec.snapshot as any)?.meta?.turn || (rec.snapshot as any)?.M) {
            // it looks valid
        } else {
            this.log.debug?.('getSessionSnapshot: CAUTION - Loaded snapshot might be empty/partial', {
                tenantId,
                sessionId,
                wmVersion: rec.wmVersion.toString(),
                hasMeta: !!(rec.snapshot as any)?.meta,
                hasM: !!(rec.snapshot as any)?.M,
                rawKeys: Object.keys(rec.snapshot as any || {})
            });
        }

        return {
            wmVersion: rec.wmVersion,
            snapshot: (rec.snapshot as unknown) as Record<string, unknown>,
            agentId: rec.agentId,
            updatedAt: rec.updatedAt.toISOString()
        };
    }

    async getSessionSnapshotForMutation(
        tenantId: string,
        sessionId: string
    ): Promise<SessionSnapshot | null> {
        await this.ensureConnected();
        return this.runWithReconnect(() => this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<Array<{ storageNowMs: bigint }>>`
                SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "storageNowMs"
            `;
            const rec = await tx.wMSession.findUnique({
                where: { tenantId_sessionId: { tenantId, sessionId } },
            });
            const storageNowMs = rows[0]?.storageNowMs;
            if (typeof storageNowMs !== 'bigint') {
                throw new Error('WM_STORAGE_TIME_UNAVAILABLE: PostgreSQL did not return an epoch timestamp.');
            }
            const storageNowIso = new Date(Number(storageNowMs)).toISOString();
            if (!rec) {
                return {
                    exists: false,
                    wmVersion: 0n,
                    snapshot: {},
                    agentId: '',
                    updatedAt: storageNowIso,
                    storageNow: storageNowIso,
                };
            }
            return {
                exists: true,
                wmVersion: rec.wmVersion,
                snapshot: rec.snapshot as unknown as Record<string, unknown>,
                agentId: rec.agentId,
                updatedAt: rec.updatedAt.toISOString(),
                storageNow: storageNowIso,
            };
        }));
    }

    async listRunnableTurnRequests(params: {
        cursor?: RunnableTurnRequestCursor;
        limit: number;
    }): Promise<RunnableTurnRequest[]> {
        await this.ensureConnected();
        const limit = Math.max(1, Math.min(1000, params.limit));
        const cursor = params.cursor;
        const cursorClause = cursor
            ? Prisma.sql`AND ("updated_at", "tenant_id", "session_id") >
                (${new Date(cursor.updatedAt)}, ${cursor.tenantId}, ${cursor.sessionId})`
            : Prisma.empty;
        const rows = await this.runWithReconnect(() => this.prisma.$queryRaw<Array<{
            tenantId: string;
            sessionId: string;
            agentId: string;
            updatedAt: Date;
            createdAt: string;
            generation: string;
            deliveryKey: string;
            runtimeSurface: string;
        }>>(Prisma.sql`
            SELECT
                "tenant_id" AS "tenantId",
                "session_id" AS "sessionId",
                "agent_id" AS "agentId",
                "updated_at" AS "updatedAt",
                snapshot #>> '{meta,turnCoordinator,dispatchIntent,createdAt}' AS "createdAt",
                snapshot #>> '{meta,turnCoordinator,dispatchIntent,generation}' AS generation,
                snapshot #>> '{meta,turnCoordinator,dispatchIntent,deliveryKey}' AS "deliveryKey",
                snapshot #>> '{meta,turnCoordinator,dispatchIntent,runtimeSurface}' AS "runtimeSurface"
            FROM "wm_sessions"
            WHERE snapshot #> '{meta,turnCoordinator,dispatchIntent}' IS NOT NULL
              AND snapshot #> '{meta,turnCoordinator,active}' IS NULL
              AND (
                  snapshot #>> '{meta,turnCoordinator,dispatchIntent,enqueuedAt}' IS NULL
                  OR (
                      snapshot #>> '{meta,turnCoordinator,dispatchIntent,enqueuedAt}' ~
                          '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
                      AND (snapshot #>> '{meta,turnCoordinator,dispatchIntent,enqueuedAt}')::timestamptz
                          <= clock_timestamp() - INTERVAL '15 seconds'
                  )
              )
              AND snapshot #>> '{meta,turnCoordinator,requestedGeneration}' ~ '^[0-9]+$'
              AND snapshot #>> '{meta,turnCoordinator,completedGeneration}' ~ '^[0-9]+$'
              AND (snapshot #>> '{meta,turnCoordinator,requestedGeneration}')::numeric >
                  (snapshot #>> '{meta,turnCoordinator,completedGeneration}')::numeric
              ${cursorClause}
            ORDER BY "updated_at", "tenant_id", "session_id"
            LIMIT ${limit}
        `));
        return rows.flatMap((row) => {
            if (row.runtimeSurface !== 'direct' && row.runtimeSurface !== 'in_process' && row.runtimeSurface !== 'hatchet') {
                this.log.warn('Ignoring runnable turn request with invalid runtime surface', {
                    tenantId: row.tenantId,
                    sessionId: row.sessionId,
                });
                return [];
            }
            return [{
                tenantId: row.tenantId,
                sessionId: row.sessionId,
                agentId: row.agentId,
                updatedAt: row.updatedAt.toISOString(),
                createdAt: row.createdAt,
                generation: row.generation,
                deliveryKey: row.deliveryKey,
                runtimeSurface: row.runtimeSurface,
            }];
        });
    }

    /** Atomic compare-and-set snapshot. */
    async writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint }> {
        const { tenantId, sessionId, agentId, expectedWmVersion, snapshot } = params;

        await this.ensureConnected();
        return await this.runWithReconnect(async () => {
            const newVersion = expectedWmVersion + BigInt(1);
            const updated = await this.prisma.wMSession.updateMany({
                where: { tenantId, sessionId, wmVersion: expectedWmVersion },
                data: {
                    snapshot: snapshot as unknown as any,
                    wmVersion: { increment: BigInt(1) },
                },
            });
            if (updated.count === 1) {
                return { newVersion };
            }
            if (updated.count > 1) {
                throw new Error('WM_SESSION_CAS_UPDATED_MULTIPLE_ROWS');
            }

            if (expectedWmVersion === BigInt(0)) {
                try {
                    await this.prisma.wMSession.create({
                        data: {
                            tenantId,
                            sessionId,
                            agentId,
                            snapshot: snapshot as unknown as any,
                            wmVersion: newVersion,
                        },
                    });
                    return { newVersion };
                } catch (error) {
                    if (!isPrismaErrorCode(error, 'P2002')) throw error;
                }
            }

            const latest = await this.prisma.wMSession.findUnique({
                where: { tenantId_sessionId: { tenantId, sessionId } },
                select: { wmVersion: true },
            });
            const actualWmVersion = latest?.wmVersion?.toString();
            this.log.debug?.('CAS mismatch on writeSnapshotCAS (will retry upstream)', {
                tenantId,
                sessionId,
                expectedWmVersion: expectedWmVersion.toString(),
                actualWmVersion,
            });
            throw new WorkingMemoryVersionConflictError(
                {
                    tenantId,
                    sessionId,
                    expectedWmVersion: expectedWmVersion.toString(),
                    ...(actualWmVersion !== undefined ? { actualWmVersion } : {}),
                },
                'CAS_MISMATCH'
            );
        });
    }

    /**
     * Append an event with sequential seq per (tenantId, sessionId).
     */
    async appendEvent(params: {
        tenantId: string;
        sessionId: string;
        type: string;
        payload: Record<string, unknown>;
    }): Promise<{ eventId: string; seq: number }> {
        const { tenantId, sessionId, type, payload } = params;

        await this.ensureConnected();
        return await this.runWithReconnect(() => this.prisma.$transaction(async (tx: any) => {
            const last = await tx.wMEvent.findFirst({
                where: { tenantId, sessionId },
                orderBy: { seq: 'desc' },
                select: { seq: true }
            });
            const nextSeq = (last?.seq ?? 0) + 1;
            const ev = await tx.wMEvent.create({
                data: { tenantId, sessionId, seq: nextSeq, type, payload: payload as unknown as any }
            });
            return { eventId: ev.eventId, seq: ev.seq };
        }));
    }

    async listEventsSince(params: { tenantId: string; sessionId: string; sinceSeq: number }): Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>> {
        const { tenantId, sessionId, sinceSeq } = params;
        const rows = await this.prisma.wMEvent.findMany({
            where: { tenantId, sessionId, seq: { gt: sinceSeq } },
            orderBy: { seq: 'asc' }
        });
        return rows.map((r: any) => ({ eventId: r.eventId, seq: r.seq, type: r.type, payload: r.payload as any, createdAt: r.createdAt.toISOString() }));
    }

    async enqueueOutbox(params: {
        tenantId: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
        idempotencyKey?: string;
        deliveryScope?: 'process' | 'shared';
        deliveryOwnerId?: string;
    }): Promise<{ id: string }> {
        const { tenantId, topic, key, payload, idempotencyKey, deliveryScope, deliveryOwnerId } = params;
        await this.ensureConnected();
        if (idempotencyKey !== undefined) {
            const row = await this.runWithReconnect(() =>
                this.prisma.outbox.upsert({
                    where: { idempotencyKey },
                    update: {},
                    create: {
                        tenantId,
                        topic,
                        key,
                        payload: payload as unknown as Prisma.InputJsonValue,
                        idempotencyKey,
                        deliveryScope,
                        deliveryOwnerId,
                    },
                })
            );
            return { id: row.id };
        }

        const row = await this.runWithReconnect(() =>
            this.prisma.outbox.create({
                data: {
                    tenantId,
                    topic,
                    key,
                    payload: payload as unknown as Prisma.InputJsonValue,
                    deliveryScope,
                    deliveryOwnerId,
                },
            })
        );
        return { id: row.id };
    }

    async createConversationThread(params: {
        tenantId: string;
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
        expiresAt?: string | null;
    }): Promise<ConversationThreadRecord> {
        const { tenantId, conversationId, ownerAgentId, participantAgentId, expiresAt } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `INSERT INTO conversation_threads (tenant_id, conversation_id, owner_agent_id, participant_agent_id, status, created_at, updated_at, expires_at)
                 VALUES ($1, $2, $3, $4, 'open', NOW(), NOW(), $5)
                 ON CONFLICT (tenant_id, conversation_id) DO NOTHING`,
                tenantId,
                conversationId,
                ownerAgentId,
                participantAgentId,
                expiresAt ?? null
            )
        );
        const row = await this.getConversationThread({ tenantId, conversationId });
        if (!row) {
            throw new Error('CONVERSATION_THREAD_CREATE_FAILED');
        }
        return row;
    }

    async getConversationThread(params: {
        tenantId: string;
        conversationId: string;
    }): Promise<ConversationThreadRecord | null> {
        const { tenantId, conversationId } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, owner_agent_id, participant_agent_id, status,
                        created_at, updated_at,
                        closed_at, close_reason, close_reason_text, closed_by_agent_id,
                        archived_at, archived_by_agent_id, archived_reason_text, expires_at
                 FROM conversation_threads
                 WHERE tenant_id = $1 AND conversation_id = $2
                 LIMIT 1`,
                tenantId,
                conversationId
            )
        );
        const row = rows[0];
        if (!row) {
            return null;
        }
        return WorkingMemorySessionStore.parseConversationThreadRow(row);
    }

    async updateConversationThreadStatus(params: UpdateConversationThreadStatusInput): Promise<void> {
        const { tenantId, conversationId } = params;
        await this.ensureConnected();
        if (params.kind === 'close') {
            const { closedAt, closeReason, closeReasonText, closedByAgentId } = params;
            await this.runWithReconnect(() =>
                this.prisma.$executeRawUnsafe(
                    `UPDATE conversation_threads
                     SET status = 'closed',
                         closed_at = $3::timestamptz,
                         close_reason = $4,
                         close_reason_text = $5,
                         closed_by_agent_id = $6,
                         updated_at = NOW()
                     WHERE tenant_id = $1 AND conversation_id = $2`,
                    tenantId,
                    conversationId,
                    closedAt,
                    closeReason,
                    closeReasonText ?? null,
                    closedByAgentId ?? null
                )
            );
            return;
        }
        const { archivedAt, archivedByAgentId, archivedReasonText } = params;
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_threads
                 SET status = 'archived',
                     archived_at = $3::timestamptz,
                     archived_by_agent_id = $4,
                     archived_reason_text = $5,
                     updated_at = NOW()
                 WHERE tenant_id = $1 AND conversation_id = $2`,
                tenantId,
                conversationId,
                archivedAt,
                archivedByAgentId ?? null,
                archivedReasonText ?? null
            )
        );
    }

    async refreshConversationThreadExpiry(params: {
        tenantId: string;
        conversationId: string;
        expiresAt: string | null;
    }): Promise<void> {
        const { tenantId, conversationId, expiresAt } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_threads
                 SET expires_at = $3::timestamptz, updated_at = NOW()
                 WHERE tenant_id = $1 AND conversation_id = $2 AND status = 'open'`,
                tenantId,
                conversationId,
                expiresAt
            )
        );
    }

    async listConversationThreadsForSweep(params: {
        tenantId: string;
        mode: 'expireOpen' | 'archiveClosed';
        nowIso: string;
        closedBeforeIso?: string;
        limit: number;
    }): Promise<ConversationThreadSweepRow[]> {
        const { tenantId, mode, nowIso, limit } = params;
        await this.ensureConnected();
        if (mode === 'expireOpen') {
            const rows = await this.runWithReconnect(() =>
                this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                    `SELECT tenant_id, conversation_id, owner_agent_id, participant_agent_id
                     FROM conversation_threads
                     WHERE tenant_id = $1
                       AND status = 'open'
                       AND expires_at IS NOT NULL
                       AND expires_at < $2::timestamptz
                     ORDER BY expires_at ASC
                     LIMIT $3
                     FOR UPDATE SKIP LOCKED`,
                    tenantId,
                    nowIso,
                    limit
                )
            );
            return rows.map((r) => ({
                tenantId: String(r.tenant_id),
                conversationId: String(r.conversation_id),
                ownerAgentId: String(r.owner_agent_id),
                participantAgentId: String(r.participant_agent_id),
            }));
        }
        const closedBefore = params.closedBeforeIso;
        if (!closedBefore) {
            return [];
        }
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, owner_agent_id, participant_agent_id
                 FROM conversation_threads
                 WHERE tenant_id = $1
                   AND status = 'closed'
                   AND closed_at IS NOT NULL
                   AND closed_at < $2::timestamptz
                 ORDER BY closed_at ASC
                 LIMIT $3
                 FOR UPDATE SKIP LOCKED`,
                tenantId,
                closedBefore,
                limit
            )
        );
        return rows.map((r) => ({
            tenantId: String(r.tenant_id),
            conversationId: String(r.conversation_id),
            ownerAgentId: String(r.owner_agent_id),
            participantAgentId: String(r.participant_agent_id),
        }));
    }

    private static parseConversationThreadRow(row: Record<string, unknown>): ConversationThreadRecord {
        const toIso = (v: unknown): string | null | undefined => {
            if (v == null) {
                return v as null | undefined;
            }
            return new Date(String(v)).toISOString();
        };
        const cr = row.close_reason == null ? null : String(row.close_reason);
        const closeReason =
            cr === 'explicit' || cr === 'ttl' ? (cr as ConversationThreadRecord['closeReason']) : null;
        return {
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            ownerAgentId: String(row.owner_agent_id),
            participantAgentId: String(row.participant_agent_id),
            status: String(row.status) as ConversationThreadRecord['status'],
            createdAt: new Date(String(row.created_at)).toISOString(),
            updatedAt: new Date(String(row.updated_at)).toISOString(),
            closedAt: toIso(row.closed_at) ?? null,
            closeReason,
            closeReasonText: row.close_reason_text == null ? null : String(row.close_reason_text),
            closedByAgentId: row.closed_by_agent_id == null ? null : String(row.closed_by_agent_id),
            archivedAt: toIso(row.archived_at) ?? null,
            archivedByAgentId:
                row.archived_by_agent_id == null ? null : String(row.archived_by_agent_id),
            archivedReasonText:
                row.archived_reason_text == null ? null : String(row.archived_reason_text),
            expiresAt: toIso(row.expires_at) ?? null,
        };
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
        const {
            tenantId,
            conversationId,
            messageId,
            senderAgentId,
            senderMemberId,
            recipientAgentId,
            speechAct,
            payload,
            correlationId,
            idempotencyKey,
            conversationKind,
            selectorKind,
            selectorPolicyId,
        } = params;
        await this.ensureConnected();
        return this.runWithReconnect(() =>
            this.prisma.$transaction(async (tx) => {
                const seqRows = await tx.$queryRawUnsafe<Array<{ next_seq: number }>>(
                    `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
                     FROM conversation_messages
                     WHERE tenant_id = $1 AND conversation_id = $2`,
                    tenantId,
                    conversationId
                );
                const sequenceNumber = seqRows[0]?.next_seq ?? 1;
                await tx.$executeRawUnsafe(
                    `INSERT INTO conversation_messages
                    (id, tenant_id, conversation_id, sequence_number, message_id, sender_agent_id, sender_member_id, recipient_agent_id, speech_act, payload, correlation_id, idempotency_key, conversation_kind, selector_kind, selector_policy_id, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, NOW())`,
                    messageId,
                    tenantId,
                    conversationId,
                    sequenceNumber,
                    messageId,
                    senderAgentId,
                    senderMemberId,
                    recipientAgentId,
                    speechAct,
                    JSON.stringify(payload),
                    correlationId ?? null,
                    idempotencyKey ?? null,
                    conversationKind,
                    selectorKind,
                    selectorPolicyId ?? null
                );
                return {
                    tenantId,
                    conversationId,
                    sequenceNumber,
                    messageId,
                    senderAgentId,
                    senderMemberId,
                    recipientAgentId,
                    conversationKind,
                    selectorKind,
                    selectorPolicyId: selectorPolicyId ?? null,
                    speechAct,
                    payload,
                    correlationId,
                    idempotencyKey,
                    createdAt: new Date().toISOString(),
                };
            })
        );
    }

    async findConversationMessageByIdempotencyKey(params: {
        tenantId: string;
        conversationId: string;
        senderMemberId: string;
        idempotencyKey: string;
    }): Promise<ConversationMessageRecord | null> {
        const { tenantId, conversationId, senderMemberId, idempotencyKey } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, sequence_number, message_id, sender_agent_id, sender_member_id, recipient_agent_id, speech_act, payload, correlation_id, idempotency_key, conversation_kind, selector_kind, selector_policy_id, created_at
                 FROM conversation_messages
                 WHERE tenant_id = $1 AND conversation_id = $2 AND sender_member_id = $3 AND idempotency_key = $4
                 LIMIT 1`,
                tenantId,
                conversationId,
                senderMemberId,
                idempotencyKey
            )
        );
        const row = rows[0];
        if (!row) {
            return null;
        }
        return {
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            sequenceNumber: Number(row.sequence_number),
            messageId: String(row.message_id),
            senderAgentId: String(row.sender_agent_id),
            senderMemberId: String(row.sender_member_id),
            recipientAgentId: row.recipient_agent_id == null ? null : String(row.recipient_agent_id),
            conversationKind: (String(row.conversation_kind ?? 'thread')) as ConversationKind,
            selectorKind: row.selector_kind == null ? null : String(row.selector_kind),
            selectorPolicyId: row.selector_policy_id == null ? null : String(row.selector_policy_id),
            speechAct: String(row.speech_act),
            payload: (row.payload as Record<string, unknown>) ?? {},
            correlationId: row.correlation_id == null ? undefined : String(row.correlation_id),
            idempotencyKey: row.idempotency_key == null ? undefined : String(row.idempotency_key),
            createdAt: new Date(String(row.created_at)).toISOString(),
        };
    }

    async listConversationMessages(params: {
        tenantId: string;
        conversationId: string;
        sinceSequence?: number;
    }): Promise<ConversationMessageRecord[]> {
        const { tenantId, conversationId } = params;
        const sinceSequence = params.sinceSequence ?? 0;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, sequence_number, message_id, sender_agent_id, sender_member_id, recipient_agent_id, speech_act, payload, correlation_id, idempotency_key, conversation_kind, selector_kind, selector_policy_id, created_at
                 FROM conversation_messages
                 WHERE tenant_id = $1 AND conversation_id = $2 AND sequence_number > $3
                 ORDER BY sequence_number ASC`,
                tenantId,
                conversationId,
                sinceSequence
            )
        );
        return rows.map((row) => ({
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            sequenceNumber: Number(row.sequence_number),
            messageId: String(row.message_id),
            senderAgentId: String(row.sender_agent_id),
            senderMemberId: String(row.sender_member_id),
            recipientAgentId: row.recipient_agent_id == null ? null : String(row.recipient_agent_id),
            conversationKind: (String(row.conversation_kind ?? 'thread')) as ConversationKind,
            selectorKind: row.selector_kind == null ? null : String(row.selector_kind),
            selectorPolicyId: row.selector_policy_id == null ? null : String(row.selector_policy_id),
            speechAct: String(row.speech_act),
            payload: (row.payload as Record<string, unknown>) ?? {},
            correlationId: row.correlation_id == null ? undefined : String(row.correlation_id),
            idempotencyKey: row.idempotency_key == null ? undefined : String(row.idempotency_key),
            createdAt: new Date(String(row.created_at)).toISOString(),
        }));
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
        const { tenantId, conversationId, ownerAgentId, defaultSelectorKind, defaultSelectorData, stopPolicies, members } =
            params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `INSERT INTO conversation_topics (tenant_id, conversation_id, owner_agent_id, status, default_selector_kind, default_selector_data, stop_policies, rotation_cursor, created_at, updated_at)
                 VALUES ($1, $2, $3, 'open', $4, $5::jsonb, $6::jsonb, NULL, NOW(), NOW())
                 ON CONFLICT (tenant_id, conversation_id) DO NOTHING`,
                tenantId,
                conversationId,
                ownerAgentId,
                defaultSelectorKind,
                JSON.stringify(defaultSelectorData),
                JSON.stringify(stopPolicies)
            )
        );
        for (const m of members) {
            await this.runWithReconnect(() =>
                this.prisma.$executeRawUnsafe(
                    `INSERT INTO conversation_topic_members (tenant_id, conversation_id, member_id, agent_id, role, session_id, registered_at, left_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, NULL)
                     ON CONFLICT (tenant_id, conversation_id, member_id) DO NOTHING`,
                    tenantId,
                    conversationId,
                    m.memberId,
                    m.agentId,
                    m.role,
                    m.sessionId,
                    m.registeredAt
                )
            );
        }
        const row = await this.getConversationTopic({ tenantId, conversationId });
        if (!row) {
            throw new Error('CONVERSATION_TOPIC_CREATE_FAILED');
        }
        return row;
    }

    async getConversationTopic(params: {
        tenantId: string;
        conversationId: string;
    }): Promise<ConversationTopicRecord | null> {
        const { tenantId, conversationId } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, owner_agent_id, status, default_selector_kind, default_selector_data, stop_policies, rotation_cursor,
                        closed_at, close_reason, close_reason_text, closed_by_agent_id, closed_by_member_id,
                        archived_at, archived_by_agent_id, archived_by_member_id, archived_reason_text,
                        created_at, updated_at
                 FROM conversation_topics WHERE tenant_id = $1 AND conversation_id = $2 LIMIT 1`,
                tenantId,
                conversationId
            )
        );
        const row = rows[0];
        if (!row) {
            return null;
        }
        const rawPolicies = row.stop_policies;
        const stopPolicies = Array.isArray(rawPolicies) ? rawPolicies : JSON.parse(String(rawPolicies ?? '[]'));
        const toIso = (v: unknown): string | null | undefined => {
            if (v == null) {
                return v as null | undefined;
            }
            return new Date(String(v)).toISOString();
        };
        const cr = row.close_reason == null ? null : String(row.close_reason);
        const closeReason: ConversationTopicCloseReason | null =
            cr === 'explicit' || cr === 'ttl' || cr === 'archived' ? cr : null;
        return {
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            ownerAgentId: String(row.owner_agent_id),
            status: String(row.status) as 'open' | 'closed' | 'archived',
            defaultSelectorKind: String(row.default_selector_kind),
            defaultSelectorData: (row.default_selector_data as Record<string, unknown>) ?? {},
            stopPolicies,
            rotationCursor: row.rotation_cursor == null ? null : String(row.rotation_cursor),
            closedAt: toIso(row.closed_at) ?? null,
            closeReason,
            closeReasonText: row.close_reason_text == null ? null : String(row.close_reason_text),
            closedByAgentId: row.closed_by_agent_id == null ? null : String(row.closed_by_agent_id),
            closedByMemberId: row.closed_by_member_id == null ? null : String(row.closed_by_member_id),
            archivedAt: toIso(row.archived_at) ?? null,
            archivedByAgentId: row.archived_by_agent_id == null ? null : String(row.archived_by_agent_id),
            archivedByMemberId: row.archived_by_member_id == null ? null : String(row.archived_by_member_id),
            archivedReasonText: row.archived_reason_text == null ? null : String(row.archived_reason_text),
            createdAt: new Date(String(row.created_at)).toISOString(),
            updatedAt: new Date(String(row.updated_at)).toISOString(),
        };
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
        const { tenantId, conversationId, patch } = params;
        const parts: string[] = [];
        const vals: unknown[] = [tenantId, conversationId];
        let n = 3;
        if (patch.status !== undefined) {
            parts.push(`status = $${n++}`);
            vals.push(patch.status);
        }
        if (patch.rotationCursor !== undefined) {
            parts.push(`rotation_cursor = $${n++}`);
            vals.push(patch.rotationCursor);
        }
        if (patch.defaultSelectorKind !== undefined) {
            parts.push(`default_selector_kind = $${n++}`);
            vals.push(patch.defaultSelectorKind);
        }
        if (patch.defaultSelectorData !== undefined) {
            parts.push(`default_selector_data = $${n++}::jsonb`);
            vals.push(JSON.stringify(patch.defaultSelectorData));
        }
        if (patch.closedAt !== undefined) {
            parts.push(`closed_at = $${n++}::timestamptz`);
            vals.push(patch.closedAt);
        }
        if (patch.closeReason !== undefined) {
            parts.push(`close_reason = $${n++}`);
            vals.push(patch.closeReason);
        }
        if (patch.closeReasonText !== undefined) {
            parts.push(`close_reason_text = $${n++}`);
            vals.push(patch.closeReasonText);
        }
        if (patch.closedByAgentId !== undefined) {
            parts.push(`closed_by_agent_id = $${n++}`);
            vals.push(patch.closedByAgentId);
        }
        if (patch.closedByMemberId !== undefined) {
            parts.push(`closed_by_member_id = $${n++}`);
            vals.push(patch.closedByMemberId);
        }
        if (patch.archivedAt !== undefined) {
            parts.push(`archived_at = $${n++}::timestamptz`);
            vals.push(patch.archivedAt);
        }
        if (patch.archivedByAgentId !== undefined) {
            parts.push(`archived_by_agent_id = $${n++}`);
            vals.push(patch.archivedByAgentId);
        }
        if (patch.archivedByMemberId !== undefined) {
            parts.push(`archived_by_member_id = $${n++}`);
            vals.push(patch.archivedByMemberId);
        }
        if (patch.archivedReasonText !== undefined) {
            parts.push(`archived_reason_text = $${n++}`);
            vals.push(patch.archivedReasonText);
        }
        if (parts.length === 0) {
            return;
        }
        parts.push('updated_at = NOW()');
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_topics SET ${parts.join(', ')} WHERE tenant_id = $1 AND conversation_id = $2`,
                ...vals
            )
        );
    }

    async listConversationTopicsForSweep(params: {
        tenantId: string;
        closedBeforeIso: string;
        limit: number;
    }): Promise<ConversationTopicSweepRow[]> {
        const { tenantId, closedBeforeIso, limit } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, owner_agent_id
                 FROM conversation_topics
                 WHERE tenant_id = $1
                   AND status = 'closed'
                   AND archived_at IS NULL
                   AND closed_at IS NOT NULL
                   AND closed_at < $2::timestamptz
                 ORDER BY closed_at ASC
                 LIMIT $3
                 FOR UPDATE SKIP LOCKED`,
                tenantId,
                closedBeforeIso,
                limit
            )
        );
        return rows.map((r) => ({
            tenantId: String(r.tenant_id),
            conversationId: String(r.conversation_id),
            ownerAgentId: String(r.owner_agent_id),
        }));
    }

    async listConversationTopicMembers(params: {
        tenantId: string;
        conversationId: string;
        activeOnly?: boolean;
    }): Promise<ConversationTopicMemberRecord[]> {
        const { tenantId, conversationId } = params;
        await this.ensureConnected();
        const activeClause = params.activeOnly ? 'AND left_at IS NULL' : '';
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, member_id, agent_id, role, session_id, registered_at, left_at
                 FROM conversation_topic_members
                 WHERE tenant_id = $1 AND conversation_id = $2 ${activeClause}
                 ORDER BY registered_at ASC, member_id ASC`,
                tenantId,
                conversationId
            )
        );
        return rows.map((row) => ({
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            memberId: String(row.member_id),
            agentId: String(row.agent_id),
            role: String(row.role) as 'owner' | 'participant',
            sessionId: String(row.session_id),
            registeredAt: new Date(String(row.registered_at)).toISOString(),
            leftAt: row.left_at == null ? null : new Date(String(row.left_at)).toISOString(),
        }));
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
        const p = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `INSERT INTO conversation_topic_members (tenant_id, conversation_id, member_id, agent_id, role, session_id, registered_at, left_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, NULL)`,
                p.tenantId,
                p.conversationId,
                p.memberId,
                p.agentId,
                p.role,
                p.sessionId,
                p.registeredAt
            )
        );
    }

    async leaveConversationTopicMember(params: {
        tenantId: string;
        conversationId: string;
        memberId: string;
        leftAt: string;
    }): Promise<void> {
        const p = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_topic_members SET left_at = $4::timestamp
                 WHERE tenant_id = $1 AND conversation_id = $2 AND member_id = $3`,
                p.tenantId,
                p.conversationId,
                p.memberId,
                p.leftAt
            )
        );
    }

    async getConversationTopicMemberByMemberId(params: {
        tenantId: string;
        conversationId: string;
        memberId: string;
    }): Promise<ConversationTopicMemberRecord | null> {
        const { tenantId, conversationId, memberId } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, member_id, agent_id, role, session_id, registered_at, left_at
                 FROM conversation_topic_members
                 WHERE tenant_id = $1 AND conversation_id = $2 AND member_id = $3 AND left_at IS NULL
                 LIMIT 1`,
                tenantId,
                conversationId,
                memberId
            )
        );
        const row = rows[0];
        if (!row) {
            return null;
        }
        return {
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            memberId: String(row.member_id),
            agentId: String(row.agent_id),
            role: String(row.role) as 'owner' | 'participant',
            sessionId: String(row.session_id),
            registeredAt: new Date(String(row.registered_at)).toISOString(),
            leftAt: row.left_at == null ? null : new Date(String(row.left_at)).toISOString(),
        };
    }

    async listConversationTopicMembersByAgent(params: {
        tenantId: string;
        conversationId: string;
        agentId: string;
        activeOnly?: boolean;
    }): Promise<ConversationTopicMemberRecord[]> {
        const { tenantId, conversationId, agentId } = params;
        await this.ensureConnected();
        const activeClause = params.activeOnly ? 'AND left_at IS NULL' : '';
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, member_id, agent_id, role, session_id, registered_at, left_at
                 FROM conversation_topic_members
                 WHERE tenant_id = $1 AND conversation_id = $2 AND agent_id = $3 ${activeClause}
                 ORDER BY registered_at ASC, member_id ASC`,
                tenantId,
                conversationId,
                agentId
            )
        );
        return rows.map((row) => ({
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            memberId: String(row.member_id),
            agentId: String(row.agent_id),
            role: String(row.role) as 'owner' | 'participant',
            sessionId: String(row.session_id),
            registeredAt: new Date(String(row.registered_at)).toISOString(),
            leftAt: row.left_at == null ? null : new Date(String(row.left_at)).toISOString(),
        }));
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
        const p = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `INSERT INTO conversation_topic_invites
                 (token, tenant_id, conversation_id, invitee_agent_id, invitee_member_id, role, session_id_override, issued_at, expires_at, inviter_agent_id, inviter_member_id, inviter_session_id, consumed_at, declined_at, decline_reason, delivery_attempted_at, delivered_at, delivery_attempts, delivery_failure_reason, idempotency_key, correlation_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $9::timestamp, $10, $11, $12, NULL, NULL, NULL, NULL, NULL, 0, NULL, $13, $14)`,
                p.token,
                p.tenantId,
                p.conversationId,
                p.inviteeAgentId,
                p.inviteeMemberId,
                p.role,
                p.sessionIdOverride,
                p.issuedAt,
                p.expiresAt,
                p.inviterAgentId,
                p.inviterMemberId,
                p.inviterSessionId,
                p.idempotencyKey,
                p.correlationId
            )
        );
    }

    async findConversationTopicInviteByIdempotencyKey(params: {
        tenantId: string;
        conversationId: string;
        idempotencyKey: string;
    }): Promise<ConversationTopicInviteRecord | null> {
        const { tenantId, conversationId, idempotencyKey } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT token, tenant_id, conversation_id, invitee_agent_id, invitee_member_id, role, session_id_override, issued_at, expires_at, inviter_agent_id, inviter_member_id, inviter_session_id, consumed_at, declined_at, decline_reason, delivery_attempted_at, delivered_at, delivery_attempts, delivery_failure_reason, idempotency_key, correlation_id
                 FROM conversation_topic_invites
                 WHERE tenant_id = $1 AND conversation_id = $2 AND idempotency_key = $3
                 LIMIT 1`,
                tenantId,
                conversationId,
                idempotencyKey
            )
        );
        const row = rows[0];
        return row ? mapConversationTopicInviteRow(row) : null;
    }

    async getConversationTopicInvite(params: {
        tenantId: string;
        token: string;
    }): Promise<ConversationTopicInviteRecord | null> {
        const { tenantId, token } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT token, tenant_id, conversation_id, invitee_agent_id, invitee_member_id, role, session_id_override, issued_at, expires_at, inviter_agent_id, inviter_member_id, inviter_session_id, consumed_at, declined_at, decline_reason, delivery_attempted_at, delivered_at, delivery_attempts, delivery_failure_reason, idempotency_key, correlation_id
                 FROM conversation_topic_invites
                 WHERE token = $1 AND tenant_id = $2
                 LIMIT 1`,
                token,
                tenantId
            )
        );
        const row = rows[0];
        return row ? mapConversationTopicInviteRow(row) : null;
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
        const { tenantId, token, consumedAt } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, invitee_agent_id, invitee_member_id, role, session_id_override, inviter_agent_id, inviter_member_id, inviter_session_id, consumed_at, declined_at
                 FROM conversation_topic_invites WHERE token = $1 AND tenant_id = $2 LIMIT 1`,
                token,
                tenantId
            )
        );
        const row = rows[0];
        if (!row || row.consumed_at != null || row.declined_at != null) {
            return null;
        }
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_topic_invites SET consumed_at = $2::timestamp WHERE token = $1`,
                token,
                consumedAt
            )
        );
        const im = row.invitee_member_id;
        return {
            conversationId: String(row.conversation_id),
            inviteeAgentId: String(row.invitee_agent_id),
            inviteeMemberId: im == null ? String(row.invitee_agent_id) : String(im),
            role: String(row.role) as 'owner' | 'participant',
            sessionIdOverride: row.session_id_override == null ? null : String(row.session_id_override),
            inviterAgentId: String(row.inviter_agent_id),
            inviterMemberId: String(row.inviter_member_id),
            inviterSessionId: String(row.inviter_session_id),
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
        const { tenantId, token, declinedAt, reason } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT conversation_id, invitee_agent_id, invitee_member_id, inviter_agent_id, inviter_member_id, inviter_session_id, consumed_at, declined_at
                 FROM conversation_topic_invites WHERE token = $1 AND tenant_id = $2 LIMIT 1`,
                token,
                tenantId
            )
        );
        const row = rows[0];
        if (!row || row.consumed_at != null || row.declined_at != null) {
            return null;
        }
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_topic_invites
                 SET consumed_at = $2::timestamp, declined_at = $2::timestamp, decline_reason = $3
                 WHERE token = $1`,
                token,
                declinedAt,
                reason
            )
        );
        const im = row.invitee_member_id;
        return {
            conversationId: String(row.conversation_id),
            inviterAgentId: String(row.inviter_agent_id),
            inviterMemberId: String(row.inviter_member_id),
            inviterSessionId: String(row.inviter_session_id),
            inviteeAgentId: String(row.invitee_agent_id),
            inviteeMemberId: im == null ? String(row.invitee_agent_id) : String(im),
        };
    }

    async listExpiredConversationTopicInvites(params: {
        tenantId: string;
        nowIso: string;
        limit: number;
    }): Promise<ConversationTopicInviteRecord[]> {
        const { tenantId, nowIso, limit } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT token, tenant_id, conversation_id, invitee_agent_id, invitee_member_id, role, session_id_override, issued_at, expires_at, inviter_agent_id, inviter_member_id, inviter_session_id, consumed_at, declined_at, decline_reason, delivery_attempted_at, delivered_at, delivery_attempts, delivery_failure_reason, idempotency_key, correlation_id
                 FROM conversation_topic_invites
                 WHERE tenant_id = $1
                   AND consumed_at IS NULL
                   AND declined_at IS NULL
                   AND expires_at < $2::timestamp
                 ORDER BY expires_at ASC
                 LIMIT $3`,
                tenantId,
                nowIso,
                limit
            )
        );
        return rows.map((row) => mapConversationTopicInviteRow(row));
    }

    async listUndeliveredConversationTopicInvites(params: {
        tenantId: string;
        nowIso: string;
        limit: number;
    }): Promise<ConversationTopicInviteRecord[]> {
        const { tenantId, nowIso, limit } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT token, tenant_id, conversation_id, invitee_agent_id, invitee_member_id, role, session_id_override, issued_at, expires_at, inviter_agent_id, inviter_member_id, inviter_session_id, consumed_at, declined_at, decline_reason, delivery_attempted_at, delivered_at, delivery_attempts, delivery_failure_reason, idempotency_key, correlation_id
                 FROM conversation_topic_invites
                 WHERE tenant_id = $1
                   AND consumed_at IS NULL
                   AND declined_at IS NULL
                   AND delivered_at IS NULL
                   AND expires_at >= $2::timestamp
                 ORDER BY issued_at ASC
                 LIMIT $3`,
                tenantId,
                nowIso,
                limit
            )
        );
        return rows.map((row) => mapConversationTopicInviteRow(row));
    }

    async markConversationTopicInviteDeliveryAttempt(params: {
        tenantId: string;
        token: string;
        attemptedAt: string;
    }): Promise<number> {
        const { tenantId, token, attemptedAt } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `UPDATE conversation_topic_invites
                 SET delivery_attempted_at = $3::timestamp,
                     delivery_attempts = delivery_attempts + 1
                 WHERE token = $1 AND tenant_id = $2
                 RETURNING delivery_attempts`,
                token,
                tenantId,
                attemptedAt
            )
        );
        const row = rows[0];
        return Number(row?.delivery_attempts ?? 0);
    }

    async markConversationTopicInviteDelivered(params: {
        tenantId: string;
        token: string;
        deliveredAt: string;
    }): Promise<void> {
        const { tenantId, token, deliveredAt } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_topic_invites
                 SET delivered_at = $3::timestamp,
                     delivery_failure_reason = NULL
                 WHERE token = $1 AND tenant_id = $2`,
                token,
                tenantId,
                deliveredAt
            )
        );
    }

    async setConversationTopicInviteDeliveryFailureReason(params: {
        tenantId: string;
        token: string;
        reason: string;
    }): Promise<void> {
        const { tenantId, token, reason } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_topic_invites
                 SET delivery_failure_reason = $3
                 WHERE token = $1 AND tenant_id = $2`,
                token,
                tenantId,
                reason
            )
        );
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
        const { tenantId, conversationId, sequenceNumber } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(
                    `DELETE FROM conversation_message_deliveries WHERE tenant_id = $1 AND conversation_id = $2 AND sequence_number = $3`,
                    tenantId,
                    conversationId,
                    sequenceNumber
                );
                for (const r of params.rows) {
                    const id = `dlv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                    await tx.$executeRawUnsafe(
                        `INSERT INTO conversation_message_deliveries
                        (id, tenant_id, conversation_id, sequence_number, member_id, recipient_agent_id, session_id, dedupe_hit, status, error, queue_position)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
                        id,
                        tenantId,
                        conversationId,
                        sequenceNumber,
                        r.memberId,
                        r.recipientAgentId,
                        r.sessionId,
                        r.dedupeHit,
                        r.status,
                        r.error == null ? null : JSON.stringify(r.error),
                        r.queuePosition
                    );
                }
            })
        );
    }

    async listConversationMessageDeliveries(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
    }): Promise<ConversationMessageDeliveryRecord[]> {
        const { tenantId, conversationId, sequenceNumber } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, sequence_number, member_id, recipient_agent_id, session_id, dedupe_hit, status, error, queue_position
                 FROM conversation_message_deliveries
                 WHERE tenant_id = $1 AND conversation_id = $2 AND sequence_number = $3`,
                tenantId,
                conversationId,
                sequenceNumber
            )
        );
        return rows.map((row) => ({
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            sequenceNumber: Number(row.sequence_number),
            memberId: String(row.member_id),
            recipientAgentId: String(row.recipient_agent_id),
            sessionId: String(row.session_id),
            dedupeHit: Boolean(row.dedupe_hit),
            status: String(row.status) as ConversationMessageDeliveryRecord['status'],
            error: row.error == null ? null : (row.error as Record<string, unknown>),
            queuePosition: row.queue_position == null ? null : Number(row.queue_position),
        }));
    }

    async updateConversationMessageDelivery(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
        memberId: string;
        status: ConversationMessageDeliveryRecord['status'];
        error?: Record<string, unknown> | null;
        queuePosition?: number | null;
    }): Promise<void> {
        const { tenantId, conversationId, sequenceNumber, memberId } = params;
        await this.ensureConnected();
        const setQueuePosition = params.queuePosition !== undefined;
        if (setQueuePosition) {
            await this.runWithReconnect(() =>
                this.prisma.$executeRawUnsafe(
                    `UPDATE conversation_message_deliveries
                     SET status = $1, error = $2::jsonb, queue_position = $3
                     WHERE tenant_id = $4 AND conversation_id = $5 AND sequence_number = $6 AND member_id = $7`,
                    params.status,
                    params.error == null ? null : JSON.stringify(params.error),
                    params.queuePosition,
                    tenantId,
                    conversationId,
                    sequenceNumber,
                    memberId
                )
            );
            return;
        }
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_message_deliveries
                 SET status = $1, error = $2::jsonb
                 WHERE tenant_id = $3 AND conversation_id = $4 AND sequence_number = $5 AND member_id = $6`,
                params.status,
                params.error == null ? null : JSON.stringify(params.error),
                tenantId,
                conversationId,
                sequenceNumber,
                memberId
            )
        );
    }

    async getDurableSubscriptionCursor(params: {
        tenantId: string;
        streamId: string;
        consumerId: string;
    }): Promise<{ sequenceNumber: number; updatedAt: string } | null> {
        const { tenantId, streamId, consumerId } = params;
        await this.ensureConnected();
        const row = await this.runWithReconnect(() =>
            this.prisma.durableSubscriptionCursor.findUnique({
                where: {
                    tenantId_streamId_consumerId: { tenantId, streamId, consumerId },
                },
            })
        );
        if (!row) {
            return null;
        }
        return {
            sequenceNumber: row.sequenceNumber,
            updatedAt: row.updatedAt.toISOString(),
        };
    }

    async upsertDurableSubscriptionCursor(params: {
        tenantId: string;
        streamId: string;
        consumerId: string;
        sequenceNumber: number;
        updatedAt: string;
    }): Promise<void> {
        const { tenantId, streamId, consumerId, sequenceNumber, updatedAt } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.durableSubscriptionCursor.upsert({
                where: {
                    tenantId_streamId_consumerId: { tenantId, streamId, consumerId },
                },
                create: {
                    tenantId,
                    streamId,
                    consumerId,
                    sequenceNumber,
                    updatedAt: new Date(updatedAt),
                },
                update: {
                    sequenceNumber,
                    updatedAt: new Date(updatedAt),
                },
            })
        );
    }

    async appendConversationDeadLetter(params: {
        tenantId: string;
        conversationId: string;
        sequenceNumber: number;
        consumerId: string;
        record: Record<string, unknown>;
        lastError: string;
        attempts: number;
        deadletteredAt: string;
    }): Promise<void> {
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.conversationDeadLetter.create({
                data: {
                    tenantId: params.tenantId,
                    conversationId: params.conversationId,
                    sequenceNumber: params.sequenceNumber,
                    consumerId: params.consumerId,
                    record: params.record as unknown as object,
                    lastError: params.lastError,
                    attempts: params.attempts,
                    deadletteredAt: new Date(params.deadletteredAt),
                },
            })
        );
    }
}
