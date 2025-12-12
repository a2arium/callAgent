import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '@a2arium/callagent-memory-engine';

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

    // Helper method for testing/debugging (not part of interface)
    clear(): void {
        this.snapshots.clear();
        this.events.clear();
        this.outbox = [];
    }

    // Helper to get all snapshots (for debugging)
    getAllSnapshots(): Map<string, WMSessionSnapshot> {
        return new Map(this.snapshots);
    }
}

