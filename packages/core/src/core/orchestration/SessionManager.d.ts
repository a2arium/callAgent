import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../memory/stores/SessionStore.js';
export declare class SessionManager {
    private readonly store?;
    constructor(store?: IWorkingMemorySessionStore | undefined);
    load(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null>;
    appendEvent(tenantId: string, sessionId: string, type: string, payload: Record<string, unknown>): Promise<{
        eventId: string;
        seq: number;
    }>;
    saveSnapshot(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{
        newVersion: bigint;
    } | null>;
    enqueueOutbox(tenantId: string, topic: string, key: string, payload: Record<string, unknown>): Promise<void>;
    listEventsSince(params: {
        tenantId: string;
        sessionId: string;
        sinceSeq: number;
    }): Promise<{
        eventId: string;
        seq: number;
        type: string;
        payload: Record<string, unknown>;
        createdAt: string;
    }[]>;
}
