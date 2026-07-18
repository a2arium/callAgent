import { describe, expect, it, jest } from '@jest/globals';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';

function makeAdapter({ entities = [], alignmentRows = [] }: {
    entities?: Array<{ id: string; canonicalName: string; aliases: string[] }>;
    alignmentRows?: Array<{ memory_key: string }>;
}) {
    const prisma = {
        $connect: jest.fn(),
        $queryRaw: jest.fn(async () => alignmentRows),
        entityStore: { findMany: jest.fn(async () => entities) },
    } as any;
    const adapter = new MemorySQLAdapter(prisma) as any;
    return { adapter, prisma };
}

describe('semantic entity candidate expansion', () => {
    it('uses one set-based join for exact entity filters regardless of match count', async () => {
        const { adapter, prisma } = makeAdapter({
            alignmentRows: Array.from({ length: 100 }, (_, index) => ({ memory_key: `memory:${index}` })),
        });
        const keys = await adapter.findMemoryKeysByEntityFilter('venue', 'ENTITY_EXACT', 'Arena', 'tenant-a');
        expect(keys.size).toBe(100);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
        expect(prisma.entityStore.findMany).not.toHaveBeenCalled();
    });

    it('bounds fuzzy entity loading and batches all matching alignments in one query', async () => {
        const entities = Array.from({ length: 100 }, (_, index) => ({
            id: `entity:${index}`,
            canonicalName: `Arena ${index}`,
            aliases: [`Hall ${index}`],
        }));
        const { adapter, prisma } = makeAdapter({ entities, alignmentRows: [{ memory_key: 'memory:1' }] });
        const keys = await adapter.findMemoryKeysByEntityFilter('venue', 'ENTITY_FUZZY', 'Arena 1', 'tenant-a');
        expect([...keys]).toEqual(['memory:1']);
        expect(prisma.entityStore.findMany).toHaveBeenCalledWith(expect.objectContaining({
            orderBy: { id: 'asc' },
            take: 50_001,
        }));
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('fails before alignment I/O when entity expansion exceeds its budget', async () => {
        const { adapter, prisma } = makeAdapter({
            entities: [
                { id: '1', canonicalName: 'one', aliases: [] },
                { id: '2', canonicalName: 'two', aliases: [] },
                { id: '3', canonicalName: 'three', aliases: [] },
            ],
        });
        adapter.maxResidualScanRows = 2;
        await expect(adapter.findMemoryKeysByEntityFilter('venue', 'ENTITY_FUZZY', 'one', 'tenant-a'))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_SCAN_BUDGET_EXCEEDED' });
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
});
