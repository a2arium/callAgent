/** Contract tests for the real ctx.memory.semantic registry. */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SemanticMemoryRegistry } from '@a2arium/callagent-memory-engine';

describe('ctx.memory.semantic real registry', () => {
    let store: Map<string, { key: string; value: unknown; tags: string[] }>;
    let backend: any;
    let semantic: SemanticMemoryRegistry;

    beforeEach(() => {
        store = new Map();
        backend = {
            capabilities: {
                tagQuery: { allOf: true, returnsStoredTags: true },
                predicateRemoval: { allOfTags: true, predicateRechecked: true, returnsCount: true },
            },
            get: jest.fn(async (key: string) => store.get(key)?.value ?? null),
            set: jest.fn(async (key: string, value: unknown, options?: { tags?: string[] }) => {
                store.set(key, { key, value, tags: options?.tags ?? [] });
            }),
            read: jest.fn(async (input: any) => {
                let rows = [...store.values()];
                if (input.tags) rows = rows.filter((row) => input.tags.every((tag: string) => row.tags.includes(tag)));
                if (input.filters) {
                    rows = rows.filter((row) => input.filters.every((filter: any) =>
                        typeof filter === 'object' && (row.value as any)?.[filter.path] === filter.value
                    ));
                }
                return rows.slice(0, input.limit);
            }),
            delete: jest.fn(async (key: string) => { store.delete(key); }),
            remove: jest.fn(async (input: any) => {
                const keys = [...store.values()]
                    .filter((row) => !input.tags || input.tags.every((tag: string) => row.tags.includes(tag)))
                    .slice(0, input.limit)
                    .map((row) => row.key);
                keys.forEach((key) => store.delete(key));
                return keys.length;
            }),
            recognize: jest.fn(),
            enrich: jest.fn(),
        };
        semantic = new SemanticMemoryRegistry({ sql: backend }, 'sql');
    });

    it('normalizes writes and returns complete stored tags through a native all-of query', async () => {
        await semantic.add({ id: 'proposal:1', value: { state: 'ready' }, tags: [' Ready ', 'SITE:42', 'ready'] });
        await semantic.add({ id: 'proposal:2', value: { state: 'draft' }, tags: ['ready'] });

        const result = await semantic.readItems<{ state: string }>({ tag: 'READY', tags: ['site:42'], limit: 1 });
        expect(result).toEqual([{
            id: 'proposal:1',
            value: { state: 'ready' },
            tags: ['ready', 'site:42'],
            entities: undefined,
        }]);
        expect((backend.read.mock.calls as unknown[][])[0]?.[0]).toEqual({ tags: ['ready', 'site:42'], limit: 1 });
    });

    it('does not post-filter a limited backend result', async () => {
        backend.read.mockResolvedValueOnce([{ key: 'backend-choice', value: {}, tags: ['a', 'b'] }]);
        await expect(semantic.readItems({ tags: ['a', 'b'], limit: 1 }))
            .resolves.toHaveLength(1);
        expect(backend.read).toHaveBeenCalledTimes(1);
    });

    it('uses strict counted removal and rejects selector-free removal', async () => {
        await semantic.add({ id: 'tmp:1', value: {}, tags: ['temporary'] });
        await semantic.add({ id: 'tmp:2', value: {}, tags: ['temporary'] });
        await expect(semantic.removeItems({ tag: ' TEMPORARY ', limit: 1 }))
            .resolves.toEqual({ removedCount: 1 });
        await expect(semantic.removeItems({ tags: [] }))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' });
    });

    it('propagates single-key deletion failures', async () => {
        backend.delete.mockRejectedValueOnce(new Error('database unavailable'));
        await expect(semantic.removeItem('key')).rejects.toThrow('database unavailable');
    });
});
