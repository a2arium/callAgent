import { describe, expect, it, jest } from '@jest/globals';
import { SemanticMemoryRegistry, type SemanticMemoryEvent } from '../src/types/semantic/SemanticMemoryRegistry.js';

describe('SemanticMemoryRegistry', () => {
    const backendWith = (overrides: Record<string, unknown> = {}) => ({
        get: jest.fn(async () => null),
        read: jest.fn(async () => []),
        set: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
        remove: jest.fn(async () => 0),
        recognize: jest.fn(async () => ({ isMatch: false, confidence: 0, usedLLM: false })),
        enrich: jest.fn(async () => ({ enrichedData: {}, changes: [], usedLLM: false, saved: false })),
        ...overrides,
    }) as any;

    it('supports high-level add() and emits an operator write event', async () => {
        const set = jest.fn(async () => undefined);
        const events: SemanticMemoryEvent[] = [];
        const registry = new SemanticMemoryRegistry(
            {
                sql: {
                    get: jest.fn(async () => null),
                    set,
                    delete: jest.fn(async () => undefined),
                    recognize: jest.fn(async () => ({ recognized: false })),
                    enrich: jest.fn(async () => ({ enriched: false })),
                } as any,
            },
            'sql',
            (event) => { events.push(event); }
        );

        await registry.add({
            id: 'selectors:cian',
            value: { container: '.item' },
            tags: ['selectors', 'cian'],
            entities: { siteId: 'cian' },
        });

        expect(set).toHaveBeenCalledWith(
            'selectors:cian',
            { container: '.item' },
            { tags: ['selectors', 'cian'], entities: { siteId: 'cian' } }
        );
        expect(events).toEqual([
            {
                op: 'write',
                keys: ['selectors:cian'],
                backend: 'sql',
                source: 'context.memory',
            },
        ]);
    });

    it('rejects mutations after the task guard closes while preserving reads', async () => {
        const get = jest.fn(async () => ({ visible: true }));
        const set = jest.fn(async () => undefined);
        let allowed = true;
        const registry = new SemanticMemoryRegistry(
            { sql: backendWith({ get, set }) },
            'sql',
            undefined,
            undefined,
            () => {
                if (!allowed) throw Object.assign(new Error('worker unavailable'), {
                    code: 'HATCHET_WORKER_STREAM_UNAVAILABLE',
                });
            }
        );

        await expect(registry.get('key')).resolves.toEqual({ visible: true });
        allowed = false;
        await expect(registry.get('key')).resolves.toEqual({ visible: true });
        await expect(registry.set('key', 'value')).rejects.toMatchObject({
            code: 'HATCHET_WORKER_STREAM_UNAVAILABLE',
        });
        expect(set).not.toHaveBeenCalled();
    });

    it('returns undefined when the selected backend has no atomic capability', () => {
        const registry = new SemanticMemoryRegistry({ mlo: {} as any }, 'mlo');
        expect(registry.getAtomic()).toBeUndefined();
    });

    it('binds atomic operations to an explicitly selected backend and emits only successful events', async () => {
        const events: SemanticMemoryEvent[] = [];
        const compareAndSet = jest.fn(async ({ expectedVersion }: { expectedVersion: string | null }) =>
            expectedVersion === '4'
                ? { status: 'updated' as const, version: '5' }
                : { status: 'conflict' as const, currentVersion: '5' }
        );
        const registry = new SemanticMemoryRegistry(
            {
                mlo: {} as any,
                sql: {
                    atomic: {
                        getVersioned: jest.fn(async () => ({ value: { active: 4 }, version: '4' })),
                        compareAndSet,
                    },
                } as any,
            },
            'mlo',
            (event) => { events.push(event); }
        );

        const atomic = registry.getAtomic({ backend: 'sql' });
        expect(atomic).toBeDefined();
        await expect(atomic!.getVersioned('site:active')).resolves.toEqual({ value: { active: 4 }, version: '4' });
        await expect(atomic!.compareAndSet({ key: 'site:active', expectedVersion: '4', value: { active: 5 } }))
            .resolves.toEqual({ status: 'updated', version: '5' });
        await expect(atomic!.compareAndSet({ key: 'site:active', expectedVersion: '3', value: { active: 6 } }))
            .resolves.toEqual({ status: 'conflict', currentVersion: '5' });

        expect(events).toEqual([
            { op: 'read', keys: ['site:active'], backend: 'sql', source: 'context.memory' },
            { op: 'write', keys: ['site:active'], backend: 'sql', source: 'context.memory' },
        ]);
    });

    it('throws the registry error for an unknown atomic backend', () => {
        const registry = new SemanticMemoryRegistry({ sql: {} as any }, 'sql');
        expect(() => registry.getAtomic({ backend: 'missing' })).toThrow('No such backend: missing');
    });

    it('normalizes tag plus tags into one all-of backend predicate before limit and returns stored tags', async () => {
        const read = jest.fn(async () => [{ key: 'proposal:1', value: { state: 'ready' }, tags: ['ready', 'site:42', 'proposal'] }]);
        const registry = new SemanticMemoryRegistry({
            sql: backendWith({
                capabilities: { tagQuery: { allOf: true, returnsStoredTags: true } },
                read,
            }),
        }, 'sql');

        await expect(registry.readItems({
            tag: ' READY ',
            tags: ['ready', ' Site:42 '],
            limit: 1,
        })).resolves.toEqual([{
            id: 'proposal:1',
            value: { state: 'ready' },
            tags: ['ready', 'site:42', 'proposal'],
            entities: undefined,
        }]);
        expect(read).toHaveBeenCalledTimes(1);
        expect((read.mock.calls as unknown[][])[0]?.[0]).toEqual({ tags: ['ready', 'site:42'], limit: 1 });
    });

    it('fails closed when a custom backend cannot execute a plural all-of query', async () => {
        const read = jest.fn(async () => []);
        const registry = new SemanticMemoryRegistry({ custom: backendWith({ read }) }, 'custom');

        await expect(registry.readItems({ tags: ['one', 'two'], limit: 5 }))
            .rejects.toMatchObject({ code: 'SEMANTIC_TAG_QUERY_UNSUPPORTED' });
        expect(read).not.toHaveBeenCalled();
    });

    it('keeps one-tag source compatibility for an undeclared custom backend', async () => {
        const read = jest.fn(async () => []);
        const registry = new SemanticMemoryRegistry({ custom: backendWith({ read }) }, 'custom');

        await registry.readItems({ tags: [' One '] });
        expect((read.mock.calls as unknown[][])[0]?.[0]).toEqual({ tag: 'one', limit: 1000 });
    });

    it('exposes pagination only when a backend implements it and routes normalized pages', async () => {
        const withoutPagination = new SemanticMemoryRegistry({ custom: backendWith() }, 'custom');
        expect(withoutPagination.readItemsPage).toBeUndefined();

        const readPage = jest.fn(async () => ({
            items: [{ id: 'record:1', value: { ready: true }, tags: ['one', 'two', 'stored'] }],
            nextCursor: 'opaque',
        }));
        const events: SemanticMemoryEvent[] = [];
        const registry = new SemanticMemoryRegistry({
            mlo: backendWith(),
            sql: backendWith({
                capabilities: { tagQuery: { allOf: true, returnsStoredTags: true } },
                pagination: { readPage },
            }),
        }, 'mlo', (event) => { events.push(event); });

        const page = registry.readItemsPage;
        expect(page).toBeDefined();
        await expect(page!({
            tag: ' TWO ',
            tags: ['one', 'two'],
            backend: 'sql',
            limit: 25,
            cursor: 'incoming-opaque-cursor',
        })).resolves.toEqual({
            items: [{ id: 'record:1', value: { ready: true }, tags: ['one', 'two', 'stored'] }],
            nextCursor: 'opaque',
        });
        expect((readPage.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
            tags: ['two', 'one'],
            limit: 25,
            orderBy: { path: 'updatedAt', direction: 'desc' },
            cursor: 'incoming-opaque-cursor',
        });
        expect((readPage.mock.calls as unknown[][])[0]?.[1]).toMatchObject({ backendName: 'sql' });
        expect(events.at(-1)).toMatchObject({
            op: 'read',
            resultKeys: ['record:1'],
            query: { paginated: true, hasNextPage: true, outcome: 'ok' },
        });
    });

    it('fails closed for an unsupported selected page backend and invalid limits', async () => {
        const readPage = jest.fn(async () => ({ items: [] }));
        const registry = new SemanticMemoryRegistry({
            mlo: backendWith(),
            sql: backendWith({ pagination: { readPage } }),
        }, 'mlo');
        const page = registry.readItemsPage!;

        await expect(page({ backend: 'mlo', limit: 1 }))
            .rejects.toMatchObject({ code: 'SEMANTIC_BACKEND_METHOD_UNAVAILABLE' });
        await expect(page({ backend: 'sql', limit: 0 }))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_LIMIT_INVALID' });
        expect(readPage).not.toHaveBeenCalled();
    });

    it('rejects empty cursors and unsupported runtime selectors before invoking a page backend', async () => {
        const readPage = jest.fn(async () => ({ items: [] }));
        const registry = new SemanticMemoryRegistry({
            sql: backendWith({ pagination: { readPage } }),
        }, 'sql');
        const page = registry.readItemsPage!;

        await expect(page({ backend: 'sql', limit: 1, cursor: '' }))
            .rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_INVALID' });
        await expect(page({ backend: 'sql', limit: 1, cursor: '   ' }))
            .rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_INVALID' });
        await expect(page({ backend: 'sql', limit: 1, id: 'record:1' } as any))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' });
        await expect(page({ backend: 'sql', limit: 1, random: false } as any))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' });
        expect(readPage).not.toHaveBeenCalled();
    });

    it('rejects exact-id predicates and honors caller order while skipping missing ids', async () => {
        const get = jest.fn(async (key: string) => key === 'b' ? { found: key } : null);
        const events: SemanticMemoryEvent[] = [];
        const registry = new SemanticMemoryRegistry(
            { primary: backendWith({ capabilities: { backendKind: 'sql' }, get }) },
            'primary',
            (event) => { events.push(event); }
        );

        await expect(registry.readItems({ id: 'a', tags: ['x'] }))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' });
        await expect(registry.readItems({ id: ['a', 'b', 'c'], limit: 1 }))
            .resolves.toEqual([{ id: 'b', value: { found: 'b' } }]);
        expect(get.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            op: 'read',
            resultKeys: ['b'],
            resultCount: 1,
            query: { queryMode: 'id', backendKind: 'sql', outcome: 'ok' },
        });
    });

    it('uses the strict counted removal capability and sends the full normalized predicate', async () => {
        const remove = jest.fn(async () => 2);
        const events: SemanticMemoryEvent[] = [];
        const registry = new SemanticMemoryRegistry({
            sql: backendWith({
                capabilities: {
                    tagQuery: { allOf: true, returnsStoredTags: true },
                    predicateRemoval: { allOfTags: true, predicateRechecked: true, returnsCount: true },
                },
                remove,
            }),
        }, 'sql', (event) => { events.push(event); });

        await expect(registry.removeItems({ tag: ' Ready ', tags: ['site:42'], limit: 2 }))
            .resolves.toEqual({ removedCount: 2 });
        expect((remove.mock.calls as unknown[][])[0]?.[0]).toEqual({ tags: ['ready', 'site:42'], limit: 2 });
        expect(events.at(-1)).toMatchObject({
            op: 'delete',
            resultCount: 2,
            status: 'success',
            query: { operation: 'remove', requiredTagCount: 2, outcome: 'ok' },
        });
    });

    it('rejects empty and incapable strict removal without invoking the backend', async () => {
        const remove = jest.fn(async () => 1);
        const registry = new SemanticMemoryRegistry({ custom: backendWith({ remove }) }, 'custom');

        await expect(registry.removeItems({ tags: [] }))
            .rejects.toMatchObject({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' });
        await expect(registry.removeItems({ tag: 'ready' }))
            .rejects.toMatchObject({ code: 'SEMANTIC_PREDICATE_REMOVE_UNSUPPORTED' });
        expect(remove).not.toHaveBeenCalled();
    });

    it('rejects strict entity removal during capability preflight', async () => {
        const remove = jest.fn(async () => 1);
        const registry = new SemanticMemoryRegistry({
            primary: backendWith({
                capabilities: {
                    backendKind: 'sql',
                    predicateRemoval: {
                        allOfTags: true,
                        predicateRechecked: true,
                        returnsCount: true,
                        entityFilters: false,
                    },
                },
                remove,
            }),
        }, 'primary');

        await expect(registry.removeItems({
            filters: [{ path: 'venue', operator: 'ENTITY_EXACT', value: 'Arena' }],
        })).rejects.toMatchObject({
            code: 'SEMANTIC_PREDICATE_REMOVE_UNSUPPORTED',
            details: { backendKind: 'sql' },
        });
        expect(remove).not.toHaveBeenCalled();
    });

    it('emits sanitized compatibility usage and swallowed-failure events on every deprecated use', async () => {
        const events: SemanticMemoryEvent[] = [];
        const remove = jest.fn(async () => { throw new Error('contains-sensitive-data'); });
        const backend = backendWith({ remove });
        const registry = new SemanticMemoryRegistry(
            { legacy: backend },
            'legacy',
            (event) => { events.push(event); }
        );

        await registry.removeItem({ tag: 'secret-tag', backend: 'legacy' });
        await registry.removeItem({ tag: 'another-secret-tag', backend: 'legacy' });

        const compatibility = events.filter((event) => event.query?.compatibilityPath === 'legacy-object-remove');
        expect(compatibility).toHaveLength(4);
        expect(compatibility.map((event) => event.query?.outcome)).toEqual(['ok', 'error', 'ok', 'error']);
        expect(JSON.stringify(compatibility)).not.toContain('secret-tag');
        expect(JSON.stringify(compatibility)).not.toContain('contains-sensitive-data');
    });

    it('normalizes replacement tags on ordinary writes and successful CAS transitions', async () => {
        const set = jest.fn(async () => undefined);
        const compareAndSet = jest.fn(async () => ({ status: 'updated' as const, version: '2' }));
        const registry = new SemanticMemoryRegistry({
            sql: backendWith({
                set,
                atomic: { getVersioned: jest.fn(), compareAndSet },
            }),
        }, 'sql');

        await registry.set('record:1', {}, { tags: [' Ready ', 'ready', ' SITE:42 '] });
        await registry.getAtomic()!.compareAndSet(
            { key: 'record:1', expectedVersion: '1', value: { state: 'claimed' } },
            { tags: [' Claimed ', 'SITE:42'] }
        );
        expect((set.mock.calls as unknown[][])[0]?.[2]).toMatchObject({ tags: ['ready', 'site:42'] });
        expect((compareAndSet.mock.calls as unknown[][])[0]?.[1]).toEqual({ tags: ['claimed', 'site:42'] });
    });

    it('throws typed low-level errors for missing backends instead of returning empty results', async () => {
        const registry = new SemanticMemoryRegistry({ sql: backendWith() }, 'sql');
        await expect(registry.read({}, { backend: 'missing' }))
            .rejects.toMatchObject({ code: 'SEMANTIC_BACKEND_NOT_FOUND' });
        await expect(registry.remove({}, { backend: 'missing' }))
            .rejects.toMatchObject({ code: 'SEMANTIC_BACKEND_NOT_FOUND' });
    });
});
