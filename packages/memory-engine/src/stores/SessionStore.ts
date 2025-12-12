export type WMSessionSnapshot = {
    wmVersion: bigint;
    snapshot: Record<string, unknown>;
    agentId: string;
    updatedAt: string; // ISO
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
}


