import { jest } from '@jest/globals';
import { InMemorySessionStore } from '../src/internal/stores/inMemorySessionStore.js';
import { PrismaSessionStore } from '../src/internal/stores/prismaSessionStore.js';

describe('InMemorySessionStore', () => {
    it('stores and clears session records', async () => {
        const store = new InMemorySessionStore();
        await store.upsert({ key: 'k', agentId: 'a', taskId: 't', state: 'running', lastActivityAt: Date.now() });
        expect(await store.get('k')).toMatchObject({ agentId: 'a', taskId: 't' });
        await store.clear('k');
        expect(await store.get('k')).toBeNull();
    });
});

describe('PrismaSessionStore', () => {
    const mock = {
        $queryRaw: jest.fn(),
        $executeRaw: jest.fn()
    };
    const store = new PrismaSessionStore(mock as any);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('get() returns null when no rows', async () => {
        mock.$queryRaw.mockResolvedValueOnce([]);
        expect(await store.get('k1')).toBeNull();
    });

    it('get() maps row fields', async () => {
        mock.$queryRaw.mockResolvedValueOnce([{ key: 'k1', agentId: 'a', taskId: 't', state: 'running', token: 'tok', lastEventSeq: 2, updatedAt: new Date().toISOString() }]);
        const res = await store.get('k1');
        expect(res).toMatchObject({ key: 'k1', agentId: 'a', taskId: 't', token: 'tok', lastEventSeq: 2 });
    });

    it('upsert clears when conflict and wasProcessed checks', async () => {
        mock.$executeRaw.mockResolvedValue(undefined);
        await store.upsert({ key: 'k', agentId: 'a', taskId: 't', state: 'running', lastEventSeq: 1, lastActivityAt: Date.now() });
        expect(mock.$executeRaw).toHaveBeenCalled();

        mock.$queryRaw.mockResolvedValueOnce([{ id: 1 }]);
        expect(await store.wasProcessed('k', 'm')).toBe(true);
    });

    it('markProcessed inserts idempotency marker', async () => {
        mock.$executeRaw.mockResolvedValue(undefined);
        await store.markProcessed('k', 'm');
        expect(mock.$executeRaw).toHaveBeenCalled();
    });
});
