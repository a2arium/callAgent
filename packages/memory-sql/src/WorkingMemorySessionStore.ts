import { PrismaClient } from './generated/prisma/index.js';
import type { PrismaClient as PrismaClientType, Prisma } from './generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { logger } from '@a2arium/callagent-utils';
import { validatePgEnvironment, dumpPgEnvironment } from './pgEnvValidator.js';
import { getSafePgConfig } from './safePool.js';

export type SessionSnapshot = {
    wmVersion: bigint;
    snapshot: Record<string, unknown>;
    agentId: string;
    updatedAt: string;
};

type ConversationThreadRecord = {
    tenantId: string;
    conversationId: string;
    ownerAgentId: string;
    participantAgentId: string;
    status: 'open' | 'closed' | 'archived';
    createdAt: string;
    updatedAt: string;
};

type ConversationMessageRecord = {
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

export class WorkingMemorySessionStore {
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

    /**
     * Atomic compare-and-set snapshot.
     * Throws Error('CAS_MISMATCH') if expected != current.
     */
    async writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint }> {
        const { tenantId, sessionId, agentId, expectedWmVersion, snapshot } = params;

        await this.ensureConnected();
        return await this.runWithReconnect(() => this.prisma.$transaction(async (tx: any) => {
            const existing = await tx.wMSession.findUnique({
                where: { tenantId_sessionId: { tenantId, sessionId } },
                select: { wmVersion: true }
            });

            const currentVersion = existing?.wmVersion ?? BigInt(0);
            if (currentVersion !== expectedWmVersion) {
                this.log.debug?.('CAS mismatch on writeSnapshotCAS (will retry upstream)', {
                    tenantId,
                    sessionId,
                    expectedWmVersion: expectedWmVersion.toString(),
                    currentVersion: currentVersion.toString()
                });
                throw new Error('CAS_MISMATCH');
            }

            const newVersion = currentVersion + BigInt(1);
            await tx.wMSession.upsert({
                where: { tenantId_sessionId: { tenantId, sessionId } },
                update: { snapshot: snapshot as unknown as any, wmVersion: newVersion },
                create: { tenantId, sessionId, agentId, snapshot: snapshot as unknown as any, wmVersion: newVersion }
            });

            return { newVersion };
        }));
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
    }): Promise<void> {
        const { tenantId, topic, key, payload } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() => this.prisma.outbox.create({ data: { tenantId, topic, key, payload: payload as unknown as any } }));
    }

    async createConversationThread(params: {
        tenantId: string;
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
    }): Promise<ConversationThreadRecord> {
        const { tenantId, conversationId, ownerAgentId, participantAgentId } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `INSERT INTO conversation_threads (tenant_id, conversation_id, owner_agent_id, participant_agent_id, status, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'open', NOW(), NOW())
                 ON CONFLICT (tenant_id, conversation_id) DO NOTHING`,
                tenantId,
                conversationId,
                ownerAgentId,
                participantAgentId
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
                `SELECT tenant_id, conversation_id, owner_agent_id, participant_agent_id, status, created_at, updated_at
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
        return {
            tenantId: String(row.tenant_id),
            conversationId: String(row.conversation_id),
            ownerAgentId: String(row.owner_agent_id),
            participantAgentId: String(row.participant_agent_id),
            status: String(row.status) as 'open' | 'closed' | 'archived',
            createdAt: new Date(String(row.created_at)).toISOString(),
            updatedAt: new Date(String(row.updated_at)).toISOString(),
        };
    }

    async updateConversationThreadStatus(params: {
        tenantId: string;
        conversationId: string;
        status: 'open' | 'closed' | 'archived';
    }): Promise<void> {
        const { tenantId, conversationId, status } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() =>
            this.prisma.$executeRawUnsafe(
                `UPDATE conversation_threads
                 SET status = $3, updated_at = NOW()
                 WHERE tenant_id = $1 AND conversation_id = $2`,
                tenantId,
                conversationId,
                status
            )
        );
    }

    async appendConversationMessage(params: {
        tenantId: string;
        conversationId: string;
        messageId: string;
        senderAgentId: string;
        recipientAgentId: string;
        speechAct: string;
        payload: Record<string, unknown>;
        correlationId?: string;
        idempotencyKey?: string;
    }): Promise<ConversationMessageRecord> {
        const { tenantId, conversationId, messageId, senderAgentId, recipientAgentId, speechAct, payload, correlationId, idempotencyKey } = params;
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
                    (id, tenant_id, conversation_id, sequence_number, message_id, sender_agent_id, recipient_agent_id, speech_act, payload, correlation_id, idempotency_key, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, NOW())`,
                    messageId,
                    tenantId,
                    conversationId,
                    sequenceNumber,
                    messageId,
                    senderAgentId,
                    recipientAgentId,
                    speechAct,
                    JSON.stringify(payload),
                    correlationId ?? null,
                    idempotencyKey ?? null
                );
                return {
                    tenantId,
                    conversationId,
                    sequenceNumber,
                    messageId,
                    senderAgentId,
                    recipientAgentId,
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
        senderAgentId: string;
        idempotencyKey: string;
    }): Promise<ConversationMessageRecord | null> {
        const { tenantId, conversationId, senderAgentId, idempotencyKey } = params;
        await this.ensureConnected();
        const rows = await this.runWithReconnect(() =>
            this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT tenant_id, conversation_id, sequence_number, message_id, sender_agent_id, recipient_agent_id, speech_act, payload, correlation_id, idempotency_key, created_at
                 FROM conversation_messages
                 WHERE tenant_id = $1 AND conversation_id = $2 AND sender_agent_id = $3 AND idempotency_key = $4
                 LIMIT 1`,
                tenantId,
                conversationId,
                senderAgentId,
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
            recipientAgentId: String(row.recipient_agent_id),
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
                `SELECT tenant_id, conversation_id, sequence_number, message_id, sender_agent_id, recipient_agent_id, speech_act, payload, correlation_id, idempotency_key, created_at
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
            recipientAgentId: String(row.recipient_agent_id),
            speechAct: String(row.speech_act),
            payload: (row.payload as Record<string, unknown>) ?? {},
            correlationId: row.correlation_id == null ? undefined : String(row.correlation_id),
            idempotencyKey: row.idempotency_key == null ? undefined : String(row.idempotency_key),
            createdAt: new Date(String(row.created_at)).toISOString(),
        }));
    }
}

