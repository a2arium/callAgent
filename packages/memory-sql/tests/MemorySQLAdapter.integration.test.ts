/**
 * Integration tests for MemorySQLAdapter.
 *
 * These tests run against a REAL PostgreSQL database.
 * They are SKIPPED when MEMORY_DATABASE_URL is not set.
 *
 * Run:   MEMORY_DATABASE_URL="postgresql://..." node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/MemorySQLAdapter.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { SemanticAtomicError } from '@a2arium/callagent-types';

const DB_URL = process.env.MEMORY_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

describeIfDb('MemorySQLAdapter integration', () => {
    let adapter: InstanceType<typeof MemorySQLAdapter>;
    const TENANT = `test-tenant-${Date.now()}`;

    beforeAll(async () => {
        adapter = new MemorySQLAdapter({
            databaseUrl: DB_URL!,
            defaultTenantId: TENANT,
        });
    });

    afterAll(async () => {
        // Clean up all test data for this tenant
        try {
            const all = await adapter.getMany('*', { tenantId: TENANT } as any);
            for (const entry of all) {
                await adapter.delete(entry.key);
            }
        } catch { /* best effort */ }
        await adapter.disconnect();
    });

    // ── Helpers ──────────────────────────────────────────────────────
    async function seed() {
        await adapter.set('user:alice', {
            name: 'Alice Johnson',
            status: 'active',
            priority: 10,
            department: 'Engineering',
            email: 'alice@company.com',
            profile: {
                tier: 'premium',
                settings: { theme: 'dark', notifications: true },
            },
        }, { tags: ['user', 'premium', 'engineering'] });

        await adapter.set('user:bob', {
            name: 'Bob Smith',
            status: 'inactive',
            priority: 3,
            department: 'Marketing',
            email: 'bob@company.com',
            profile: {
                tier: 'basic',
                settings: { theme: 'light', notifications: false },
            },
        }, { tags: ['user', 'marketing'] });

        await adapter.set('user:carol', {
            name: 'Carol Williams',
            status: 'active',
            priority: 7,
            department: 'Engineering',
            email: 'carol@example.com',
            profile: {
                tier: 'premium',
                settings: { theme: 'dark', notifications: true },
            },
        }, { tags: ['user', 'premium', 'engineering'] });

        await adapter.set('config:theme', {
            defaultTheme: 'dark',
            options: ['dark', 'light', 'system'],
        }, { tags: ['settings'] });

        await adapter.set('event:conf-2024', {
            title: 'AI Conference 2024',
            status: 'active',
            eventOccurences: [
                { date: '2024-03-15', time: '09:00', isSoldOut: false },
                { date: '2024-03-16', time: '10:00', isSoldOut: true },
            ],
            speakers: [
                { name: 'Dr. Jane Smith', affiliation: 'MIT' },
                { name: 'Prof. Bob Wilson', affiliation: 'Stanford' },
            ],
        }, { tags: ['event', 'conference'] });
    }

    // ──────────────────────────────────────────────────────────────────
    // BASIC CRUD
    // ──────────────────────────────────────────────────────────────────
    describe('Basic CRUD', () => {
        it('set + get returns the stored value', async () => {
            await adapter.set('crud:test', { hello: 'world' });
            const result = await adapter.get('crud:test');
            expect(result).toEqual({ hello: 'world' });
        });

        it('get returns null for non-existent key', async () => {
            const result = await adapter.get('crud:nonexistent');
            expect(result).toBeNull();
        });

        it('delete removes a key', async () => {
            await adapter.set('crud:del', { x: 1 });
            await adapter.delete('crud:del');
            const result = await adapter.get('crud:del');
            expect(result).toBeNull();
        });

        it('set overwrites existing value', async () => {
            await adapter.set('crud:overwrite', { v: 1 });
            await adapter.set('crud:overwrite', { v: 2 });
            const result = await adapter.get('crud:overwrite');
            expect(result).toEqual({ v: 2 });
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // PATTERN QUERIES
    // ──────────────────────────────────────────────────────────────────
    describe('Pattern queries', () => {
        beforeAll(seed);

        it('getMany("*") returns all records for tenant', async () => {
            const results = await adapter.getMany('*');
            expect(results.length).toBeGreaterThanOrEqual(5);
        });

        it('getMany("user:*") returns user records only', async () => {
            const results = await adapter.getMany('user:*');
            expect(results.length).toBe(3);
            expect(results.every((r: any) => r.key.startsWith('user:'))).toBe(true);
        });

        it('getMany("config:*") returns config records only', async () => {
            const results = await adapter.getMany('config:*');
            expect(results.length).toBe(1);
            expect(results[0].key).toBe('config:theme');
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // TAG FILTERING
    // ──────────────────────────────────────────────────────────────────
    describe('Tag filtering', () => {
        it('filters by single tag', async () => {
            const results = await adapter.getMany({ tag: 'settings' });
            expect(results.length).toBe(1);
            expect(results[0].key).toBe('config:theme');
        });

        it('filters by user tag', async () => {
            const results = await adapter.getMany({ tag: 'user' });
            expect(results.length).toBe(3);
        });

        it('filters by premium tag', async () => {
            const results = await adapter.getMany({ tag: 'premium' });
            expect(results.length).toBe(2);
        });

        it('supports random ordering', async () => {
            // Seed more items for better randomization testing
            const randomTags = ['random-test'];
            for (let i = 0; i < 10; i++) {
                await adapter.set(`random:${i}`, { val: i }, { tags: randomTags });
            }

            const results1 = await adapter.getMany({ tag: 'random-test', random: true, limit: 3 });
            const results2 = await adapter.getMany({ tag: 'random-test', random: true, limit: 3 });

            expect(results1.length).toBe(3);
            expect(results2.length).toBe(3);

            // Extract keys
            const keys1 = results1.map(r => r.key).sort();
            const keys2 = results2.map(r => r.key).sort();

            // It's technically possible they are the same, but with 10 items and 3 picked,
            // there are 120 combinations (10 C 3).
            // We'll check they are not identical as a basic verification.
            if (JSON.stringify(keys1) === JSON.stringify(keys2)) {
                const results3 = await adapter.getMany({ tag: 'random-test', random: true, limit: 3 });
                const keys3 = results3.map(r => r.key).sort();
                expect(JSON.stringify(keys1)).not.toBe(JSON.stringify(keys3));
            }
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // STRING-BASED FILTERS
    // ──────────────────────────────────────────────────────────────────
    describe('String-based filters', () => {
        it('equality: status = "active"', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['status = "active"'],
            });
            expect(results.length).toBe(2);
            expect(results.every((r: any) => r.value.status === 'active')).toBe(true);
        });

        it('inequality: status != "active"', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['status != "active"'],
            });
            expect(results.length).toBe(1);
            expect((results[0].value as any).status).toBe('inactive');
        });

        it('greater than: priority > 5', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['priority > 5'],
            });
            expect(results.length).toBe(2);
            expect(results.every((r: any) => r.value.priority > 5)).toBe(true);
        });

        it('greater than or equal: priority >= 7', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['priority >= 7'],
            });
            expect(results.length).toBe(2);
            expect(results.every((r: any) => r.value.priority >= 7)).toBe(true);
        });

        it('less than: priority < 5', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['priority < 5'],
            });
            expect(results.length).toBe(1);
            expect((results[0].value as any).priority).toBe(3);
        });

        it('less than or equal: priority <= 7', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['priority <= 7'],
            });
            expect(results.length).toBe(2);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // TEXT FILTERS
    // ──────────────────────────────────────────────────────────────────
    describe('Text filters', () => {
        it('CONTAINS: name contains "Smith"', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['name contains "Smith"'],
            });
            expect(results.length).toBe(1);
            expect((results[0].value as any).name).toBe('Bob Smith');
        });

        it('STARTS_WITH: name starts_with "Alice"', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['name starts_with "Alice"'],
            });
            expect(results.length).toBe(1);
            expect((results[0].value as any).name).toBe('Alice Johnson');
        });

        it('ENDS_WITH: email ends_with "@company.com"', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['email ends_with "@company.com"'],
            });
            expect(results.length).toBe(2);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // NESTED PATH FILTERS
    // ──────────────────────────────────────────────────────────────────
    describe('Nested path filters', () => {
        it('single-level nested: profile.tier = "premium"', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['profile.tier = "premium"'],
            });
            expect(results.length).toBe(2);
            expect(results.every((r: any) => (r.value as any).profile.tier === 'premium')).toBe(true);
        });

        it('multi-level nested: profile.settings.theme = "dark"', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['profile.settings.theme = "dark"'],
            });
            expect(results.length).toBe(2);
            expect(results.every((r: any) => r.value.profile.settings.theme === 'dark')).toBe(true);
        });

        it('multi-level nested boolean: profile.settings.notifications = true', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['profile.settings.notifications = true'],
            });
            expect(results.length).toBe(2);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // MIXED FILTERS
    // ──────────────────────────────────────────────────────────────────
    describe('Mixed string + object filters', () => {
        it('combines string and object filter in same query', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: [
                    'status = "active"',
                    { path: 'priority', operator: '>=', value: 8 },
                ],
            });
            expect(results.length).toBe(1);
            expect(results[0].value.name).toBe('Alice Johnson');
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // ARRAY EXPANSION FILTERS
    // ──────────────────────────────────────────────────────────────────
    describe('Array expansion filters', () => {
        it('filters by array element: speakers[].name contains "Jane"', async () => {
            const results = await adapter.getMany({
                filters: ['speakers[].name contains "Jane"'],
            });
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].key).toBe('event:conf-2024');
        });

        it('filters by array element: speakers[].affiliation = "Stanford"', async () => {
            const results = await adapter.getMany({
                filters: ['speakers[].affiliation = "Stanford"'],
            });
            expect(results.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // LIMIT / PAGINATION
    // ──────────────────────────────────────────────────────────────────
    describe('Limit', () => {
        it('respects limit parameter', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                limit: 1,
            });
            expect(results.length).toBe(1);
        });

        it('limit > total returns all', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                limit: 100,
            });
            expect(results.length).toBe(3);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // RESULT SHAPE
    // ──────────────────────────────────────────────────────────────────
    describe('Result shape', () => {
        it('returns { key, value } objects', async () => {
            const results = await adapter.getMany({ tag: 'settings' });
            expect(results[0]).toHaveProperty('key');
            expect(results[0]).toHaveProperty('value');
            expect(typeof results[0].key).toBe('string');
        });

        it('value is the canonical object (not wrapped)', async () => {
            const results = await adapter.getMany({ tag: 'settings' });
            expect(results[0].value).toHaveProperty('defaultTheme');
            // NOT { value: { defaultTheme: ... } }
            expect(results[0].value).not.toHaveProperty('value');
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // TENANT ISOLATION
    // ──────────────────────────────────────────────────────────────────
    describe('Tenant isolation', () => {
        const OTHER_TENANT = `other-tenant-${Date.now()}`;

        it('different tenants do not see each other\'s data', async () => {
            // Store something under a different tenant
            const otherAdapter = new MemorySQLAdapter({
                databaseUrl: DB_URL!,
                defaultTenantId: OTHER_TENANT,
            });

            await otherAdapter.set('isolated:key', { secret: 'hidden' });

            // Query from the original tenant
            const results = await adapter.getMany('isolated:*');
            expect(results.length).toBe(0);

            // Clean up other tenant
            await otherAdapter.delete('isolated:key');
            await otherAdapter.disconnect();
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // MULTIPLE FILTERS (AND logic)
    // ──────────────────────────────────────────────────────────────────
    describe('Multiple filters (AND)', () => {
        it('all filters must match', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: [
                    'status = "active"',
                    'department = "Engineering"',
                    'priority >= 7',
                ],
            });
            // Both Alice (priority 10) and Carol (priority 7) match
            expect(results.length).toBe(2);
        });

        it('filters narrow down correctly', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: [
                    'status = "active"',
                    'priority > 9',
                ],
            });
            expect(results.length).toBe(1);
            expect(results[0].value.name).toBe('Alice Johnson');
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // LOGICAL FILTERS (OR/AND)
    // ──────────────────────────────────────────────────────────────────
    describe('Logical Filters (OR/AND)', () => {
        beforeAll(seed);

        it('should filter with OR logic in SQL path', async () => {
            // Alice (priority 10) OR Bob (priority 3, inactive)
            const results = await adapter.getMany({
                filters: ['priority = 10 OR priority = 3']
            });

            expect(results).toHaveLength(2);
            const keys = results.map(r => r.key).sort();
            expect(keys).toEqual(['user:alice', 'user:bob']);
        });

        it('should filter with mixed OR and AND logic', async () => {
            // (status = active AND department = Engineering) OR priority = 3
            // Alice (active, Eng) - match
            // Carol (active, Eng) - match
            // Bob (inactive, Mark, priority 3) - match
            const results = await adapter.getMany({
                filters: ['status = "active" AND department = "Engineering" OR priority = 3']
            });

            expect(results).toHaveLength(3);
            const keys = results.map(r => r.key).sort();
            expect(keys).toEqual(['user:alice', 'user:bob', 'user:carol']);
        });

        it('should support OR with array filters', async () => {
            // event:conf-2024 has 2024-03-15
            const results = await adapter.getMany({
                filters: ['eventOccurences[].date = "2024-03-15" OR priority = 10']
            });

            // Alice (priority 10) AND event:conf-2024
            expect(results).toHaveLength(2);
            const keys = results.map(r => r.key).sort();
            expect(keys).toEqual(['event:conf-2024', 'user:alice']);
        });

        it('should handle OR with entity filters in memory fallback', async () => {
            // speaker ~ "Jane Smith" OR lead ~ "Jane Smith"
            // event:conf-2024 has speaker "Dr. Jane Smith"
            const results = await adapter.getMany({
                filters: ['speakers[].name ~ "Jane Smith" OR name = "Alice Johnson"']
            });

            expect(results).toHaveLength(2);
            const sortedKeys = results.map(r => r.key).sort();
            expect(sortedKeys).toEqual(['event:conf-2024', 'user:alice']);
        });
    });

    describe('Semantic atomic capability', () => {
        it('creates only once and reports the current generation on conflict', async () => {
            const key = `cas:create:${Date.now()}`;
            await expect(adapter.atomic.compareAndSet({ key, expectedVersion: null, value: { active: 1 } }))
                .resolves.toMatchObject({ status: 'updated' });
            const conflict = await adapter.atomic.compareAndSet({ key, expectedVersion: null, value: { active: 2 } });
            expect(conflict).toMatchObject({ status: 'conflict' });
            expect(conflict.status === 'conflict' && conflict.currentVersion).toMatch(/^[1-9][0-9]*$/);
        });

        it('updates only a matching version and leaves the winner unchanged after a stale attempt', async () => {
            const key = `cas:stale:${Date.now()}`;
            await adapter.set(key, { active: 1 });
            const initial = await adapter.atomic.getVersioned<{ active: number }>(key);
            const updated = await adapter.atomic.compareAndSet({ key, expectedVersion: initial!.version, value: { active: 2 } });
            expect(updated.status).toBe('updated');
            const stale = await adapter.atomic.compareAndSet({ key, expectedVersion: initial!.version, value: { active: 3 } });
            expect(stale.status).toBe('conflict');
            await expect(adapter.get(key)).resolves.toEqual({ active: 2 });
        });

        it('allows exactly one concurrent writer across independent adapters', async () => {
            const key = `cas:race:${Date.now()}`;
            await adapter.set(key, { winner: null });
            const initial = await adapter.atomic.getVersioned(key);
            const other = new MemorySQLAdapter({ databaseUrl: DB_URL!, defaultTenantId: TENANT });
            try {
                const results = await Promise.all([
                    adapter.atomic.compareAndSet({ key, expectedVersion: initial!.version, value: { winner: 'a' } }),
                    other.atomic.compareAndSet({ key, expectedVersion: initial!.version, value: { winner: 'b' } }),
                ]);
                expect(results.filter((result) => result.status === 'updated')).toHaveLength(1);
                expect(results.filter((result) => result.status === 'conflict')).toHaveLength(1);
                expect(['a', 'b']).toContain((await adapter.get<{ winner: string }>(key))!.winner);
            } finally {
                await other.disconnect();
            }
        });

        it('allows exactly one concurrent creator', async () => {
            const key = `cas:create-race:${Date.now()}`;
            const other = new MemorySQLAdapter({ databaseUrl: DB_URL!, defaultTenantId: TENANT });
            try {
                const results = await Promise.all([
                    adapter.atomic.compareAndSet({ key, expectedVersion: null, value: { creator: 'a' } }),
                    other.atomic.compareAndSet({ key, expectedVersion: null, value: { creator: 'b' } }),
                ]);
                expect(results.filter((result) => result.status === 'updated')).toHaveLength(1);
                expect(results.filter((result) => result.status === 'conflict')).toHaveLength(1);
            } finally {
                await other.disconnect();
            }
        });

        it('invalidates tokens on ordinary writes and delete/recreate', async () => {
            const key = `cas:aba:${Date.now()}`;
            await adapter.set(key, { generation: 1 });
            const beforeSet = await adapter.atomic.getVersioned(key);
            await adapter.set(key, { generation: 2 });
            await expect(adapter.atomic.compareAndSet({ key, expectedVersion: beforeSet!.version, value: { generation: 3 } }))
                .resolves.toMatchObject({ status: 'conflict' });

            const beforeDelete = await adapter.atomic.getVersioned(key);
            await adapter.delete(key);
            await adapter.set(key, { generation: 4 });
            const recreated = await adapter.atomic.getVersioned(key);
            expect(recreated!.version).not.toBe(beforeDelete!.version);
            await expect(adapter.atomic.compareAndSet({ key, expectedVersion: beforeDelete!.version, value: { generation: 5 } }))
                .resolves.toMatchObject({ status: 'conflict' });
        });

        it('does not reveal or mutate another tenant with a foreign token', async () => {
            const key = `cas:tenant:${Date.now()}`;
            const other = new MemorySQLAdapter({ databaseUrl: DB_URL!, defaultTenantId: `${TENANT}:other` });
            try {
                await other.set(key, { secret: true });
                const foreign = await other.atomic.getVersioned(key);
                const result = await adapter.atomic.compareAndSet({ key, expectedVersion: foreign!.version, value: { secret: false } });
                expect(result).toEqual({ status: 'conflict', currentVersion: null });
                await expect(other.get(key)).resolves.toEqual({ secret: true });
            } finally {
                await other.delete(key);
                await other.disconnect();
            }
        });

        it('validates tokens and rejects binary or entity-aligned CAS before writing', async () => {
            const key = `cas:invalid:${Date.now()}`;
            await expect(adapter.atomic.compareAndSet({ key, expectedVersion: '01', value: { ok: true } }))
                .rejects.toMatchObject({ code: 'SEMANTIC_ATOMIC_INVALID_VERSION' });
            await expect(adapter.atomic.compareAndSet({ key, expectedVersion: '9223372036854775808', value: { ok: true } }))
                .rejects.toMatchObject({ code: 'SEMANTIC_ATOMIC_INVALID_VERSION' });
            await expect(adapter.atomic.compareAndSet({ key, expectedVersion: null, value: { data: Buffer.from('binary') } }))
                .rejects.toBeInstanceOf(SemanticAtomicError);
            await expect(adapter.atomic.compareAndSet(
                { key, expectedVersion: null, value: { ok: true } },
                { entities: { site: 'site' } } as any
            )).rejects.toMatchObject({ code: 'SEMANTIC_ATOMIC_OPTION_UNSUPPORTED' });
            await expect(adapter.get(key)).resolves.toBeNull();
        });

        it('rejects lossy JavaScript values without changing the stored value or version', async () => {
            const key = `cas:json-domain:${Date.now()}`;
            await adapter.set(key, { stable: true });
            const before = await adapter.atomic.getVersioned(key);
            const sparse = new Array(2);
            sparse[1] = 'present';
            const circular: Record<string, unknown> = {};
            circular.self = circular;
            const invalidValues: unknown[] = [
                { value: undefined },
                { value: Number.NaN },
                { value: Number.POSITIVE_INFINITY },
                { value: new Date('2026-01-01T00:00:00.000Z') },
                { value: () => true },
                sparse,
                circular,
            ];

            for (const value of invalidValues) {
                await expect(adapter.atomic.compareAndSet({
                    key,
                    expectedVersion: before!.version,
                    value,
                })).rejects.toMatchObject({ code: 'SEMANTIC_ATOMIC_VALUE_UNSUPPORTED' });
            }

            await expect(adapter.atomic.getVersioned(key)).resolves.toEqual(before);
        });

        it('invalidates a version when blob metadata is removed', async () => {
            const key = `cas:blob:${Date.now()}`;
            await adapter.setBlob(key, Buffer.from('large-enough-binary'), { filename: 'x.bin' });
            await expect(adapter.atomic.getVersioned(key))
                .rejects.toMatchObject({ code: 'SEMANTIC_ATOMIC_VALUE_UNSUPPORTED' });
            const prisma = (adapter as any).prisma;
            const rowsBefore = await prisma.$queryRawUnsafe(
                'SELECT version FROM agent_memory_store WHERE tenant_id = $1 AND key = $2', TENANT, key
            );
            await adapter.deleteBlob(key);
            const rowsAfter = await prisma.$queryRawUnsafe(
                'SELECT version FROM agent_memory_store WHERE tenant_id = $1 AND key = $2', TENANT, key
            );
            expect(String(rowsAfter[0].version)).not.toBe(String(rowsBefore[0].version));
        });
    });
});
