/**
 * Tests for the ctx.semantic facade methods (read, add, remove).
 *
 * These tests verify that the facade correctly delegates to the underlying
 * ctx.memory.semantic adapter instead of fetching all records in JS.
 *
 * No database required — the adapter is fully mocked.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
function createMockAdapter() {
    // In-memory store keyed by key
    const store = new Map<string, { key: string; value: any; tags?: string[] }>();

    const adapter = {
        get: jest.fn(async (key: string) => {
            const entry = store.get(key);
            return entry ? entry.value : null;
        }),

        set: jest.fn(async (key: string, value: any, opts?: { tags?: string[]; entities?: any }) => {
            store.set(key, { key, value, tags: opts?.tags });
        }),

        read: jest.fn(async (input: any, _options?: any) => {
            // Pattern matching
            if (typeof input === 'string') {
                if (input === '*') return Array.from(store.values());
                // Simple pattern matching for tests
                const pattern = input.replace(/\*/g, '.*').replace(/\?/g, '.');
                const regex = new RegExp(`^${pattern}$`);
                return Array.from(store.values()).filter(e => regex.test(e.key));
            }

            // Query object
            let results = Array.from(store.values());

            if (input.tag) {
                results = results.filter(e => (e.tags || []).includes(input.tag));
            }

            if (input.filters && input.filters.length > 0) {
                // Simple filter engine for tests — only supports '=' on flat values
                for (const f of input.filters) {
                    if (typeof f === 'string') {
                        const match = f.match(/^(\S+)\s*=\s*"?([^"]*)"?\s*$/);
                        if (match) {
                            const [, path, val] = match;
                            results = results.filter(e => {
                                const parts = path.split('.');
                                let obj = e.value;
                                for (const p of parts) {
                                    if (obj == null) return false;
                                    obj = obj[p];
                                }
                                return String(obj) === val;
                            });
                        }
                    } else if (f.path && f.operator === '=') {
                        const parts = f.path.split('.');
                        results = results.filter((e: any) => {
                            let obj = e.value;
                            for (const p of parts) {
                                if (obj == null) return false;
                                obj = obj[p];
                            }
                            return obj === f.value;
                        });
                    }
                }
            }

            if (input.limit) {
                results = results.slice(0, input.limit);
            }

            return results;
        }),

        delete: jest.fn(async (key: string) => {
            store.delete(key);
        }),

        remove: jest.fn(async (input: any) => {
            // Simple tag-based batch delete for tests
            let count = 0;
            if (input.tag) {
                for (const [k, v] of store) {
                    if ((v.tags || []).includes(input.tag)) {
                        store.delete(k);
                        count++;
                    }
                }
            }
            return count;
        }),

        getDefaultBackend: () => 'sql',
        setDefaultBackend: () => { },
        backends: {},
        entities: undefined,
        recognize: jest.fn(),
        enrich: jest.fn(),
    };

    return { adapter, store };
}

// ── Build a ctx.semantic facade like taskEngine.restoreCtx does ──────
function buildSemanticFacade(memoryAdapter: any) {
    const ctx = {
        memory: {
            semantic: memoryAdapter,
        },
    } as any;

    // This is the exact facade code from taskEngine.ts after our fix
    const semantic = {
        add: async (item: { id: string; value: unknown; tags?: string[]; entities?: Record<string, unknown> }) => {
            await ctx.memory.semantic.set(item.id, item.value, { tags: item.tags, entities: item.entities });
        },
        remove: async (idOrPredicate: string | Record<string, unknown> | ((f: any) => boolean)) => {
            try {
                if (typeof idOrPredicate === 'string') {
                    await ctx.memory.semantic.delete(idOrPredicate);
                    return;
                }
                if (typeof idOrPredicate === 'object' && idOrPredicate !== null && typeof idOrPredicate !== 'function') {
                    const removeQuery: any = {};
                    if ((idOrPredicate as any).tag) removeQuery.tag = (idOrPredicate as any).tag;
                    if ((idOrPredicate as any).filters) removeQuery.filters = (idOrPredicate as any).filters;
                    if ((idOrPredicate as any).limit) removeQuery.limit = (idOrPredicate as any).limit;
                    const removeFn = ctx.memory.semantic.remove;
                    if (removeFn && Object.keys(removeQuery).length > 0) {
                        await removeFn(removeQuery);
                        return;
                    }
                }
                if (typeof idOrPredicate === 'function') {
                    const all = await ctx.memory.semantic.read('*');
                    if (Array.isArray(all)) {
                        for (const item of all) {
                            const mapped = { id: item?.key ?? item?.id, value: item?.value, tags: item?.tags, entities: item?.entities } as any;
                            if ((idOrPredicate as any)(mapped)) await ctx.memory.semantic.delete(mapped.id);
                        }
                    }
                }
            } catch { /* noop */ }
        },
        read: async (filter?: { id?: string | string[]; tag?: string; tags?: string[]; filters?: any[]; limit?: number; orderBy?: any }) => {
            try {
                const semanticRead = ctx.memory.semantic.read;
                if (!semanticRead) return [];

                if (filter?.id) {
                    const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
                    const results: any[] = [];
                    for (const id of ids) {
                        const val = await ctx.memory.semantic.get(id);
                        if (val !== null && val !== undefined) {
                            results.push({ id, value: val, tags: undefined, entities: undefined });
                        }
                    }
                    return typeof filter.limit === 'number' ? results.slice(0, filter.limit) : results;
                }

                const query: any = {};
                if (filter?.tag) query.tag = filter.tag;
                if (filter?.filters) query.filters = filter.filters;
                if (filter?.limit) query.limit = filter.limit;
                if (filter?.orderBy) query.orderBy = filter.orderBy;

                const rawResults = await semanticRead(
                    Object.keys(query).length > 0 ? query : '*'
                );

                const mapped = Array.isArray(rawResults)
                    ? rawResults.map((x: any) => ({
                        id: x?.key ?? x?.id,
                        value: x?.value,
                        tags: x?.tags,
                        entities: x?.entities,
                    }))
                    : [];

                if (filter?.tags && filter.tags.length > 0 && !filter?.tag) {
                    return mapped.filter((m: any) =>
                        filter.tags!.every((t: string) => (m.tags || []).includes(t))
                    );
                }

                return mapped;
            } catch {
                return [];
            }
        },
    };

    return semantic;
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('ctx.semantic facade', () => {
    let mockAdapter: ReturnType<typeof createMockAdapter>['adapter'];
    let store: ReturnType<typeof createMockAdapter>['store'];
    let semantic: ReturnType<typeof buildSemanticFacade>;

    beforeEach(() => {
        const created = createMockAdapter();
        mockAdapter = created.adapter;
        store = created.store;
        semantic = buildSemanticFacade(mockAdapter);
    });

    // ── add() ─────────────────────────────────────────────────────────
    describe('add()', () => {
        it('calls adapter.set with correct args', async () => {
            await semantic.add({ id: 'key1', value: { name: 'Alice' }, tags: ['user'] });
            expect(mockAdapter.set).toHaveBeenCalledWith(
                'key1',
                { name: 'Alice' },
                { tags: ['user'], entities: undefined }
            );
        });

        it('stores the value canonically (no double-wrapping)', async () => {
            await semantic.add({ id: 'key1', value: { status: 'active' } });
            expect(store.get('key1')?.value).toEqual({ status: 'active' });
        });
    });

    // ── read() ────────────────────────────────────────────────────────
    describe('read()', () => {
        beforeEach(async () => {
            await semantic.add({ id: 'user:1', value: { name: 'Alice', status: 'active', priority: 10 }, tags: ['user', 'premium'] });
            await semantic.add({ id: 'user:2', value: { name: 'Bob', status: 'inactive', priority: 3 }, tags: ['user'] });
            await semantic.add({ id: 'config:theme', value: { theme: 'dark' }, tags: ['settings'] });
        });

        it('returns all records when no filter is provided', async () => {
            const results = await semantic.read();
            expect(results).toHaveLength(3);
        });

        it('returns all records when empty filter is provided', async () => {
            const results = await semantic.read({});
            expect(results).toHaveLength(3);
        });

        it('fetches a single record by id', async () => {
            const results = await semantic.read({ id: 'user:1' });
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('user:1');
            expect(results[0].value).toEqual({ name: 'Alice', status: 'active', priority: 10 });
        });

        it('fetches multiple records by id array', async () => {
            const results = await semantic.read({ id: ['user:1', 'config:theme'] });
            expect(results).toHaveLength(2);
            expect(results.map((r: any) => r.id).sort()).toEqual(['config:theme', 'user:1']);
        });

        it('returns empty for non-existent id', async () => {
            const results = await semantic.read({ id: 'nonexistent' });
            expect(results).toHaveLength(0);
        });

        it('delegates tag filter to adapter.read()', async () => {
            const results = await semantic.read({ tag: 'settings' });
            expect(mockAdapter.read).toHaveBeenCalledWith(
                expect.objectContaining({ tag: 'settings' })
            );
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('config:theme');
        });

        it('delegates filters to adapter.read()', async () => {
            const results = await semantic.read({
                filters: ['status = "active"']
            });
            expect(mockAdapter.read).toHaveBeenCalledWith(
                expect.objectContaining({ filters: ['status = "active"'] })
            );
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('user:1');
        });

        it('delegates object-based filters to adapter.read()', async () => {
            const results = await semantic.read({
                filters: [{ path: 'status', operator: '=', value: 'inactive' }]
            });
            expect(mockAdapter.read).toHaveBeenCalledWith(
                expect.objectContaining({
                    filters: [{ path: 'status', operator: '=', value: 'inactive' }]
                })
            );
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('user:2');
        });

        it('respects limit', async () => {
            const results = await semantic.read({ limit: 2 });
            expect(results).toHaveLength(2);
            expect(mockAdapter.read).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 2 })
            );
        });

        it('combines tag + filters + limit in one query', async () => {
            const results = await semantic.read({
                tag: 'user',
                filters: ['status = "active"'],
                limit: 10,
            });
            expect(mockAdapter.read).toHaveBeenCalledWith(
                expect.objectContaining({
                    tag: 'user',
                    filters: ['status = "active"'],
                    limit: 10,
                })
            );
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('user:1');
        });

        it('maps adapter { key, value } to facade { id, value }', async () => {
            const results = await semantic.read({ id: 'user:1' });
            expect(results[0]).toHaveProperty('id');
            expect(results[0]).toHaveProperty('value');
            expect(results[0]).not.toHaveProperty('key');
        });
    });

    // ── read() with id + limit ────────────────────────────────────────
    describe('read() id + limit', () => {
        beforeEach(async () => {
            for (let i = 0; i < 5; i++) {
                await semantic.add({ id: `item:${i}`, value: { n: i } });
            }
        });

        it('id array + limit returns limited results', async () => {
            const results = await semantic.read({
                id: ['item:0', 'item:1', 'item:2', 'item:3', 'item:4'],
                limit: 2,
            });
            expect(results).toHaveLength(2);
        });
    });

    // ── remove() ──────────────────────────────────────────────────────
    describe('remove()', () => {
        beforeEach(async () => {
            await semantic.add({ id: 'tmp:1', value: { x: 1 }, tags: ['temporary'] });
            await semantic.add({ id: 'tmp:2', value: { x: 2 }, tags: ['temporary'] });
            await semantic.add({ id: 'keep:1', value: { x: 3 }, tags: ['permanent'] });
        });

        it('removes a single record by id string', async () => {
            await semantic.remove('tmp:1');
            expect(mockAdapter.delete).toHaveBeenCalledWith('tmp:1');
            expect(store.has('tmp:1')).toBe(false);
        });

        it('delegates object-based remove to adapter.remove()', async () => {
            await semantic.remove({ tag: 'temporary' } as any);
            expect(mockAdapter.remove).toHaveBeenCalledWith(
                expect.objectContaining({ tag: 'temporary' })
            );
        });

        it('delegates filter-based remove to adapter.remove()', async () => {
            await semantic.remove({ filters: ['x = 1'] } as any);
            expect(mockAdapter.remove).toHaveBeenCalledWith(
                expect.objectContaining({ filters: ['x = 1'] })
            );
        });

        it('supports legacy function-based remove', async () => {
            await semantic.remove(((item: any) => item.id === 'tmp:1') as any);
            expect(mockAdapter.delete).toHaveBeenCalledWith('tmp:1');
        });
    });

    // ── add() + read() roundtrip ────────────────────────────────────
    describe('roundtrip', () => {
        it('data stored with add() is retrievable with read()', async () => {
            await semantic.add({
                id: 'roundtrip-key',
                value: { nested: { deep: 'value' } },
                tags: ['test'],
            });

            const byId = await semantic.read({ id: 'roundtrip-key' });
            expect(byId).toHaveLength(1);
            expect(byId[0].value.nested.deep).toBe('value');

            const byTag = await semantic.read({ tag: 'test' });
            expect(byTag).toHaveLength(1);
            expect(byTag[0].id).toBe('roundtrip-key');
        });

        it('filter by nested path after add()', async () => {
            await semantic.add({
                id: 'nested-test',
                value: { profile: { email: 'alice@example.com' } },
            });

            const results = await semantic.read({
                filters: ['profile.email = "alice@example.com"'],
            });
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('nested-test');
        });
    });
});
