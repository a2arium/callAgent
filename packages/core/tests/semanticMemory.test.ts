/**
 * Tests for the ctx.memory.semantic agent interface methods (add, readItems, removeItem).
 *
 * These tests verify that the facade correctly delegates to the underlying
 * semantic adapter methods. The facade logic mirrors createMemoryRegistry.ts.
 *
 * No database required — the adapter is fully mocked.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

function createMockAdapter() {
    const store = new Map();

    const adapter = {
        get: jest.fn(async (key) => {
            const entry = store.get(key);
            return entry ? entry.value : null;
        }),

        set: jest.fn(async (key, value, opts) => {
            store.set(key, { key, value, tags: opts?.tags });
        }),

        read: jest.fn(async (input, _options) => {
            if (typeof input === 'string') {
                if (input === '*') return Array.from(store.values());
                const pattern = input.replace(/\*/g, '.*').replace(/\?/g, '.');
                const regex = new RegExp(`^${pattern}$`);
                return Array.from(store.values()).filter(e => regex.test(e.key));
            }

            let results = Array.from(store.values());

            if (input.tag) {
                results = results.filter(e => (e.tags || []).includes(input.tag));
            }
            if (input.tags && input.tags.length > 0) {
                results = results.filter(e => input.tags.every(t => (e.tags || []).includes(t)));
            }
            if (input.filters && input.filters.length > 0) {
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
                        results = results.filter(e => {
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

        delete: jest.fn(async (key) => {
            store.delete(key);
        }),

        remove: jest.fn(async (input) => {
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

        recognize: jest.fn(),
        enrich: jest.fn(),
    };

    return { adapter, store };
}

/**
 * Build the high-level facade exactly as createMemoryRegistry does.
 * This mirrors the add / readItems / removeItem logic from createMemoryRegistry.ts
 * so the tests validate the agent-facing API contract without needing a real DB.
 */
function buildSemanticFacade(semanticAdapter) {
    return {
        // Low-level passthrough
        get: (key) => semanticAdapter.get(key),
        set: (key, value, opts) => semanticAdapter.set(key, value, opts),
        read: (input, options) => semanticAdapter.read?.(input, options),
        delete: (key) => semanticAdapter.delete(key),
        remove: (input, options) => semanticAdapter.remove?.(input, options),
        recognize: semanticAdapter.recognize,
        enrich: semanticAdapter.enrich,

        // ── High-level Agent API ──
        add: async (item) => {
            await semanticAdapter.set(item.id, item.value, { tags: item.tags, entities: item.entities });
        },
        readItems: async (filter) => {
            if (filter?.id) {
                const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
                const results = [];
                for (const id of ids) {
                    const val = await semanticAdapter.get(id);
                    if (val !== null && val !== undefined) {
                        results.push({ id, value: val, tags: undefined, entities: undefined });
                    }
                }
                return typeof filter.limit === 'number' ? results.slice(0, filter.limit) : results;
            }
            const query = {};
            if (filter?.tag) query.tag = filter.tag;
            if (filter?.filters) query.filters = filter.filters;
            if (filter?.limit) query.limit = filter.limit;
            if (filter?.orderBy) query.orderBy = filter.orderBy;

            const rawResults = await semanticAdapter.read(Object.keys(query).length > 0 ? query : '*');
            const mapped = Array.isArray(rawResults)
                ? rawResults.map(x => ({
                    id: x?.key ?? x?.id,
                    value: x?.value,
                    tags: x?.tags,
                    entities: x?.entities,
                }))
                : [];

            if (filter?.tags && filter.tags.length > 0 && !filter?.tag) {
                return mapped.filter(m =>
                    filter.tags.every(t => (m.tags || []).includes(t))
                );
            }
            return mapped;
        },
        removeItem: async (idOrFilter) => {
            try {
                if (typeof idOrFilter === 'string') {
                    await semanticAdapter.delete(idOrFilter);
                    return;
                }
                if (typeof idOrFilter === 'object' && idOrFilter !== null && typeof idOrFilter !== 'function') {
                    const removeQuery = {};
                    if (idOrFilter.tag) removeQuery.tag = idOrFilter.tag;
                    if (idOrFilter.filters) removeQuery.filters = idOrFilter.filters;
                    if (idOrFilter.limit) removeQuery.limit = idOrFilter.limit;
                    if (Object.keys(removeQuery).length > 0) {
                        await semanticAdapter.remove(removeQuery);
                        return;
                    }
                }
                if (typeof idOrFilter === 'function') {
                    const all = await semanticAdapter.read('*');
                    if (Array.isArray(all)) {
                        for (const item of all) {
                            const mapped = { id: item?.key ?? item?.id, value: item?.value, tags: item?.tags, entities: item?.entities };
                            if (idOrFilter(mapped)) await semanticAdapter.delete(mapped.id);
                        }
                    }
                }
            } catch { /* noop */ }
        },
    };
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('ctx.memory.semantic facade', () => {
    let mockAdapter;
    let store;
    let semantic;

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

    // ── readItems() ────────────────────────────────────────────────────
    describe('readItems()', () => {
        beforeEach(async () => {
            await semantic.add({ id: 'user:1', value: { name: 'Alice', status: 'active', priority: 10 }, tags: ['user', 'premium'] });
            await semantic.add({ id: 'user:2', value: { name: 'Bob', status: 'inactive', priority: 3 }, tags: ['user'] });
            await semantic.add({ id: 'config:theme', value: { theme: 'dark' }, tags: ['settings'] });
        });

        it('returns all records when no filter is provided', async () => {
            const results = await semantic.readItems();
            expect(results).toHaveLength(3);
        });

        it('returns all records when empty filter is provided', async () => {
            const results = await semantic.readItems({});
            expect(results).toHaveLength(3);
        });

        it('fetches a single record by id', async () => {
            const results = await semantic.readItems({ id: 'user:1' });
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('user:1');
            expect(results[0].value).toEqual({ name: 'Alice', status: 'active', priority: 10 });
        });

        it('fetches multiple records by id array', async () => {
            const results = await semantic.readItems({ id: ['user:1', 'config:theme'] });
            expect(results).toHaveLength(2);
            expect(results.map(r => r.id).sort()).toEqual(['config:theme', 'user:1']);
        });

        it('returns empty for non-existent id', async () => {
            const results = await semantic.readItems({ id: 'nonexistent' });
            expect(results).toHaveLength(0);
        });

        it('delegates tag filter to adapter.read()', async () => {
            const results = await semantic.readItems({ tag: 'settings' });
            expect(mockAdapter.read).toHaveBeenCalledWith(
                expect.objectContaining({ tag: 'settings' })
            );
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('config:theme');
        });

        it('delegates filters to adapter.read()', async () => {
            const results = await semantic.readItems({
                filters: ['status = "active"']
            });
            expect(mockAdapter.read).toHaveBeenCalledWith(
                expect.objectContaining({ filters: ['status = "active"'] })
            );
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('user:1');
        });

        it('delegates object-based filters to adapter.read()', async () => {
            const results = await semantic.readItems({
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
            const results = await semantic.readItems({ limit: 2 });
            expect(results).toHaveLength(2);
            expect(mockAdapter.read).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 2 })
            );
        });

        it('combines tag + filters + limit in one query', async () => {
            const results = await semantic.readItems({
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
            const results = await semantic.readItems({ id: 'user:1' });
            expect(results[0]).toHaveProperty('id');
            expect(results[0]).toHaveProperty('value');
            expect(results[0]).not.toHaveProperty('key');
        });
    });

    // ── readItems() with id + limit ────────────────────────────────────
    describe('readItems() id + limit', () => {
        beforeEach(async () => {
            for (let i = 0; i < 5; i++) {
                await semantic.add({ id: `item:${i}`, value: { n: i } });
            }
        });

        it('id array + limit returns limited results', async () => {
            const results = await semantic.readItems({
                id: ['item:0', 'item:1', 'item:2', 'item:3', 'item:4'],
                limit: 2,
            });
            expect(results).toHaveLength(2);
        });
    });

    // ── removeItem() ──────────────────────────────────────────────────
    describe('removeItem()', () => {
        beforeEach(async () => {
            await semantic.add({ id: 'tmp:1', value: { x: 1 }, tags: ['temporary'] });
            await semantic.add({ id: 'tmp:2', value: { x: 2 }, tags: ['temporary'] });
            await semantic.add({ id: 'keep:1', value: { x: 3 }, tags: ['permanent'] });
        });

        it('removes a single record by id string', async () => {
            await semantic.removeItem('tmp:1');
            expect(mockAdapter.delete).toHaveBeenCalledWith('tmp:1');
            expect(store.has('tmp:1')).toBe(false);
        });

        it('delegates object-based remove to adapter.remove()', async () => {
            await semantic.removeItem({ tag: 'temporary' });
            expect(mockAdapter.remove).toHaveBeenCalledWith(
                expect.objectContaining({ tag: 'temporary' })
            );
        });

        it('delegates filter-based remove to adapter.remove()', async () => {
            await semantic.removeItem({ filters: ['x = 1'] });
            expect(mockAdapter.remove).toHaveBeenCalledWith(
                expect.objectContaining({ filters: ['x = 1'] })
            );
        });

        it('supports legacy function-based remove', async () => {
            await semantic.removeItem((item) => item.id === 'tmp:1');
            expect(mockAdapter.delete).toHaveBeenCalledWith('tmp:1');
        });
    });

    // ── add() + readItems() roundtrip ────────────────────────────────
    describe('roundtrip', () => {
        it('data stored with add() is retrievable with readItems()', async () => {
            await semantic.add({
                id: 'roundtrip-key',
                value: { nested: { deep: 'value' } },
                tags: ['test'],
            });

            const byId = await semantic.readItems({ id: 'roundtrip-key' });
            expect(byId).toHaveLength(1);
            expect(byId[0].value.nested.deep).toBe('value');

            const byTag = await semantic.readItems({ tag: 'test' });
            expect(byTag).toHaveLength(1);
            expect(byTag[0].id).toBe('roundtrip-key');
        });

        it('filter by nested path after add()', async () => {
            await semantic.add({
                id: 'nested-test',
                value: { profile: { email: 'alice@example.com' } },
            });

            const results = await semantic.readItems({
                filters: ['profile.email = "alice@example.com"'],
            });
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('nested-test');
        });
    });
});
