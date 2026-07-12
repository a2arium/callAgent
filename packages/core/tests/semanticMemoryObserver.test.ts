import { jest } from '@jest/globals';
import { SemanticMemoryObserverRepository } from '../src/operator/semanticMemoryObserver.js';

describe('SemanticMemoryObserverRepository', () => {
    it('applies probe filters to the complete stored value', async () => {
        const value = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, nested: { name: 'Ada' } };
        const repository = new SemanticMemoryObserverRepository({
            agentMemoryStore: { findMany: jest.fn(async () => [{ key: 'profile', value, tags: [] }]) },
        });

        const result = await repository.probe({
            tenantId: 'tenant-1',
            filters: [{ path: 'nested.name', operator: '=', value: 'Ada' }],
            limit: 10,
        });

        expect(result.resultKeys).toEqual(['profile']);
    });

    it('advances an activity cursor by scanned rows when filtering', async () => {
        const rows = Array.from({ length: 202 }, (_, index) => ({
            eventId: `event-${index}`,
            sessionId: 'task-1',
            seq: 202 - index,
            type: 'memory.read',
            payload: { keys: [`key-${index}`], agentId: index >= 200 ? 'wanted' : 'other' },
            createdAt: new Date(2026, 0, 1, 0, 0, 202 - index),
        }));
        const findMany = jest.fn(async (args: Record<string, any>) => rows.slice(args.skip, args.skip + args.take));
        const repository = new SemanticMemoryObserverRepository({ wMEvent: { findMany } });

        const result = await repository.activity({ tenantId: 'tenant-1', agentId: 'wanted', limit: 1 });

        expect(result.items.map((item) => item.id)).toEqual(['event-200']);
        expect(result.pageInfo).toEqual(expect.objectContaining({ hasMore: true, nextCursor: '202' }));
    });

    it('renames memory and its alignments in one transaction', async () => {
        const update = jest.fn(async () => ({}));
        const updateMany = jest.fn(async () => ({}));
        const findUnique = jest.fn(async () => ({ key: 'new', value: {}, tags: [] }));
        const tx = {
            agentMemoryStore: { update },
            entityAlignment: { updateMany },
        };
        const transaction = jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
        const repository = new SemanticMemoryObserverRepository({
            agentMemoryStore: { findMany: jest.fn(async () => []), findUnique },
            entityAlignment: { findMany: jest.fn(async () => []), updateMany },
            $transaction: transaction as never,
        });

        await repository.update({ tenantId: 'tenant-1', key: 'old', nextKey: 'new' });

        expect(transaction).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', memoryKey: 'old' },
            data: { memoryKey: 'new' },
        });
    });
});
