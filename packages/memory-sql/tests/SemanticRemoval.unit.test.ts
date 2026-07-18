import { describe, expect, it, jest } from '@jest/globals';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';

function adapterWithTransaction(transaction: (...args: any[]) => Promise<any>) {
    const prisma = {
        $connect: jest.fn(),
        $transaction: jest.fn(transaction),
    } as any;
    return { adapter: new MemorySQLAdapter(prisma), prisma };
}

describe('semantic structured removal SQL', () => {
    it('selects by requested priority, locks by key, rechecks tags, and returns memory-row count', async () => {
        let statement = '';
        const tx = {
            $queryRawUnsafe: jest.fn(async (sql: string) => {
                statement = sql;
                return [{ key: 'a' }, { key: 'b' }];
            }),
            $executeRaw: jest.fn(async () => 3),
        };
        const { adapter } = adapterWithTransaction(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx));

        await expect(adapter.deleteMany({
            tags: ['ready', 'site:42'],
            filters: [{ path: 'state', operator: '=', value: 'ready' }],
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 2,
        })).resolves.toBe(2);

        expect(statement).toContain('ORDER BY created_at ASC, key ASC');
        expect(statement).toContain('ORDER BY memory.key ASC');
        expect(statement).toContain('FOR UPDATE OF memory');
        expect(statement.match(/tags @>/g)).toHaveLength(2);
        expect(statement).toContain('memory.value #>>');
        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('retries only deadlock and serialization failures, at most twice', async () => {
        const tx = { $queryRawUnsafe: jest.fn(async () => []), $executeRaw: jest.fn() };
        let calls = 0;
        const { adapter, prisma } = adapterWithTransaction(async (callback: (tx: typeof tx) => Promise<unknown>) => {
            calls++;
            if (calls === 1) throw { code: '40P01' };
            if (calls === 2) throw { cause: { code: '40001' } };
            return callback(tx);
        });

        await expect(adapter.deleteMany({ tag: 'ready', limit: 1 })).resolves.toBe(0);
        expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it('classifies exhausted contention without retrying unrelated SQL errors', async () => {
        const exhausted = adapterWithTransaction(async () => { throw { code: '40P01' }; });
        await expect(exhausted.adapter.deleteMany({ tag: 'ready', limit: 1 }))
            .rejects.toMatchObject({ code: 'SEMANTIC_REMOVE_CONTENTION', retryable: true });
        expect(exhausted.prisma.$transaction).toHaveBeenCalledTimes(3);

        const unrelated = adapterWithTransaction(async () => { throw { code: '23505' }; });
        await expect(unrelated.adapter.deleteMany({ tag: 'ready', limit: 1 }))
            .rejects.toMatchObject({ code: '23505' });
        expect(unrelated.prisma.$transaction).toHaveBeenCalledTimes(1);
    });
});
