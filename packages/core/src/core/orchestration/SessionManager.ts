import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../memory/stores/SessionStore.js';

export class SessionManager {
    constructor(private readonly store?: IWorkingMemorySessionStore) { }

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

        // Enforce WM snapshot size cap (bytes)
        try {
            const serialized = JSON.stringify(params.snapshot);
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

        const result = await this.store.writeSnapshotCAS(params);
        return result;
    }

    async enqueueOutbox(tenantId: string, topic: string, key: string, payload: Record<string, unknown>) {
        if (!this.store) return;
        await this.store.enqueueOutbox({ tenantId, topic, key, payload });
    }

    async listEventsSince(params: { tenantId: string; sessionId: string; sinceSeq: number }) {
        if (!this.store) return [] as Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>;
        return this.store.listEventsSince(params);
    }
}


