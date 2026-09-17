import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';

const originalKey = process.env.SEMANTIC_CURSOR_KEY;
const prisma = {} as any;

afterEach(() => {
    if (originalKey === undefined) delete process.env.SEMANTIC_CURSOR_KEY;
    else process.env.SEMANTIC_CURSOR_KEY = originalKey;
});

describe('MemorySQLAdapter pagination capability', () => {
    it('is absent without a configured key and present with an explicit valid key', () => {
        delete process.env.SEMANTIC_CURSOR_KEY;
        const withoutKey = new MemorySQLAdapter({ prismaClient: prisma });
        const withKey = new MemorySQLAdapter({
            prismaClient: prisma,
            semanticCursorKey: Buffer.alloc(32, 11).toString('base64url'),
        });

        expect(withoutKey.pagination).toBeUndefined();
        expect(withKey.pagination?.readPage).toEqual(expect.any(Function));
    });

    it('fails initialization when an explicitly configured key is malformed', () => {
        expect(() => new MemorySQLAdapter({ prismaClient: prisma, semanticCursorKey: 'not-a-key' }))
            .toThrow(/SEMANTIC_CURSOR_KEY/);
    });

    it('rejects invalid runtime page inputs before issuing SQL', async () => {
        const queryRawUnsafe = jest.fn(async () => []);
        const adapter = new MemorySQLAdapter({
            prismaClient: { $queryRawUnsafe: queryRawUnsafe } as any,
            semanticCursorKey: Buffer.alloc(32, 13).toString('base64url'),
        });
        const readPage = adapter.pagination!.readPage;
        const options = { backendName: 'sql' };

        await expect(readPage({ limit: 1, cursor: '' }, options))
            .rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_INVALID' });
        await expect(readPage({ limit: 1, cursor: '   ' }, options))
            .rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_INVALID' });
        await expect(readPage({ limit: 1, id: 'record:1' } as any, options))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' });
        await expect(readPage({ limit: 1, random: false } as any, options))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' });
        expect(queryRawUnsafe).not.toHaveBeenCalled();

        await expect(readPage({ limit: 1, cursor: undefined }, options))
            .resolves.toEqual({ items: [] });
        expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    });
});
