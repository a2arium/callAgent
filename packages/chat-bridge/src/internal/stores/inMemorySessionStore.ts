import type { SessionRecord, SessionStore } from '../../types.js';

export class InMemorySessionStore implements SessionStore {
    private map = new Map<string, SessionRecord>();

    async get(key: string): Promise<SessionRecord | null> {
        return this.map.get(key) || null;
    }

    async upsert(rec: SessionRecord): Promise<void> {
        this.map.set(rec.key, rec);
    }

    async clear(key: string): Promise<void> {
        this.map.delete(key);
    }
}


