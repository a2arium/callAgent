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
            expect(results[0].value.status).toBe('inactive');
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
            expect(results[0].value.priority).toBe(3);
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
            expect(results[0].value.name).toBe('Bob Smith');
        });

        it('STARTS_WITH: name starts_with "Alice"', async () => {
            const results = await adapter.getMany({
                tag: 'user',
                filters: ['name starts_with "Alice"'],
            });
            expect(results.length).toBe(1);
            expect(results[0].value.name).toBe('Alice Johnson');
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
            expect(results.every((r: any) => r.value.profile.tier === 'premium')).toBe(true);
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
});
