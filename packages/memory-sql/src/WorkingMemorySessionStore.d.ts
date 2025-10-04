import { PrismaClient } from '@prisma/client';
export type SessionSnapshot = {
    wmVersion: bigint;
    snapshot: Record<string, unknown>;
    agentId: string;
    updatedAt: string;
};
export declare class WorkingMemorySessionStore {
    private readonly prisma;
    private readonly ownsPrisma;
    private readonly log;
    constructor(prisma?: PrismaClient);
    disconnect(): Promise<void>;
    close(): Promise<void>;
    getSessionSnapshot(tenantId: string, sessionId: string): Promise<SessionSnapshot | null>;
    /**
     * Atomic compare-and-set snapshot.
     * Throws Error('CAS_MISMATCH') if expected != current.
     */
    writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{
        newVersion: bigint;
    }>;
    /**
     * Append an event with sequential seq per (tenantId, sessionId).
     */
    appendEvent(params: {
        tenantId: string;
        sessionId: string;
        type: string;
        payload: Record<string, unknown>;
    }): Promise<{
        eventId: string;
        seq: number;
    }>;
    listEventsSince(params: {
        tenantId: string;
        sessionId: string;
        sinceSeq: number;
    }): Promise<Array<{
        eventId: string;
        seq: number;
        type: string;
        payload: Record<string, unknown>;
        createdAt: string;
    }>>;
    enqueueOutbox(params: {
        tenantId: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
    }): Promise<void>;
}
