import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { getSafePgConfig } from '../src/safePool.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const DB_URL = process.env.MEMORY_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;
const CURSOR_KEY = Buffer.alloc(32, 19).toString('base64url');

describeIfDb('semantic-memory keyset pagination', () => {
    const prefix = `semantic-page-${Date.now()}`;
    const tenantA = `${prefix}-a`;
    const tenantB = `${prefix}-b`;
    let adapterA: MemorySQLAdapter;
    let adapterB: MemorySQLAdapter;
    let client: pg.Client;

    beforeAll(async () => {
        client = new pg.Client({ connectionString: DB_URL });
        await client.connect();
        adapterA = new MemorySQLAdapter({
            databaseUrl: DB_URL!,
            defaultTenantId: tenantA,
            semanticCursorKey: CURSOR_KEY,
        });
        adapterB = new MemorySQLAdapter({
            databaseUrl: DB_URL!,
            defaultTenantId: tenantB,
            semanticCursorKey: CURSOR_KEY,
        });
    });

    afterAll(async () => {
        if (client) {
            await client.query('DELETE FROM agent_memory_store WHERE tenant_id = $1 OR tenant_id = $2', [tenantA, tenantB]);
            await client.end();
        }
        await adapterA?.disconnect();
        await adapterB?.disconnect();
    });

    it('paginates more than 1,000 filtered equal-timestamp rows without duplicates or omissions', async () => {
        await client.query(`
            INSERT INTO agent_memory_store
                (tenant_id, key, value, tags, created_at, updated_at)
            SELECT
                $1,
                'bulk:' || lpad(generated::text, 4, '0'),
                jsonb_build_object('state', 'ready', 'fixture', generated),
                ARRAY['page', 'ready', 'extra']::text[],
                TIMESTAMP '2026-01-01 00:00:00.000',
                TIMESTAMP '2026-01-01 00:00:00.000'
            FROM generate_series(1, 1005) AS generated
        `, [tenantA]);
        await client.query(`
            INSERT INTO agent_memory_store
                (tenant_id, key, value, tags, created_at, updated_at)
            SELECT
                $1,
                'ignored:' || generated::text,
                jsonb_build_object('state', 'draft'),
                ARRAY['page', 'ready']::text[],
                TIMESTAMP '2026-01-01 00:00:00.000',
                TIMESTAMP '2026-01-01 00:00:00.000'
            FROM generate_series(1, 10) AS generated
        `, [tenantA]);

        let activeAdapter = adapterA;
        let cursor: string | undefined;
        const ids: string[] = [];
        let pageNumber = 0;
        do {
            const page = await activeAdapter.pagination!.readPage<{ state: string }>({
                ...(pageNumber === 0
                    ? { tag: ' PAGE ', tags: ['ready'] }
                    : { tags: ['ready', 'page', 'page'] }),
                filters: [{ path: 'state', operator: '=', value: 'ready' }],
                orderBy: { path: 'createdAt', direction: 'asc' },
                limit: 137,
                ...(cursor ? { cursor } : {}),
            }, { backendName: 'sql' });
            if (pageNumber === 0) {
                expect(page.nextCursor).toBeDefined();
                expect(page.nextCursor).not.toContain(tenantA);
                expect(page.nextCursor).not.toContain('page');
                const restarted = new MemorySQLAdapter({
                    databaseUrl: DB_URL!,
                    defaultTenantId: tenantA,
                    semanticCursorKey: CURSOR_KEY,
                });
                activeAdapter = restarted;
            }
            expect(page.items.every((item) => item.tags?.join(',') === 'page,ready,extra')).toBe(true);
            ids.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor;
            pageNumber += 1;
            if (activeAdapter !== adapterA && !cursor) await activeAdapter.disconnect();
        } while (cursor);

        expect(pageNumber).toBeGreaterThan(1);
        expect(ids).toHaveLength(1005);
        expect(new Set(ids).size).toBe(1005);
        expect(ids[0]).toBe('bulk:0001');
        expect(ids.at(-1)).toBe('bulk:1005');
    }, 30_000);

    it('binds cursors to tenant, backend, filters, and ordering and rejects tampering', async () => {
        const first = await adapterA.pagination!.readPage({
            tags: ['page', 'ready'],
            filters: [{ path: 'state', operator: '=', value: 'ready' }],
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 2,
        }, { backendName: 'sql' });
        const cursor = first.nextCursor!;

        await expect(adapterB.pagination!.readPage({
            tags: ['page', 'ready'],
            filters: [{ path: 'state', operator: '=', value: 'ready' }],
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 3,
            cursor,
        }, { backendName: 'sql' })).rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_QUERY_MISMATCH' });
        await expect(adapterA.pagination!.readPage({
            tags: ['page', 'ready'],
            filters: [{ path: 'state', operator: '=', value: 'ready' }],
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 3,
            cursor,
        }, { backendName: 'another-sql' })).rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_QUERY_MISMATCH' });
        await expect(adapterA.pagination!.readPage({
            tags: ['page', 'ready'],
            filters: [{ path: 'state', operator: '=', value: 'draft' }],
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 3,
            cursor,
        }, { backendName: 'sql' })).rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_QUERY_MISMATCH' });
        await expect(adapterA.pagination!.readPage({
            tags: ['page', 'ready'],
            filters: [{ path: 'state', operator: '=', value: 'ready' }],
            orderBy: { path: 'createdAt', direction: 'desc' },
            limit: 3,
            cursor,
        }, { backendName: 'sql' })).rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_QUERY_MISMATCH' });

        const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
        await expect(adapterA.pagination!.readPage({
            tags: ['page', 'ready'],
            filters: [{ path: 'state', operator: '=', value: 'ready' }],
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 3,
            cursor: tampered,
        }, { backendName: 'sql' })).rejects.toMatchObject({ code: 'SEMANTIC_CURSOR_INVALID' });
    });

    it('fences an ascending cycle while allowing new rows in the next cycle', async () => {
        await adapterA.set('fence:1', { state: 'ready' }, { tags: ['fence'] });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await adapterA.set('fence:2', { state: 'ready' }, { tags: ['fence'] });

        const first = await adapterA.pagination!.readPage({
            tag: 'fence',
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 1,
        }, { backendName: 'sql' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await adapterA.set('fence:3', { state: 'ready' }, { tags: ['fence'] });

        const second = await adapterA.pagination!.readPage({
            tag: 'fence',
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 10,
            cursor: first.nextCursor!,
        }, { backendName: 'sql' });
        expect([...first.items, ...second.items].map((item) => item.id)).toEqual(['fence:1', 'fence:2']);
        expect(second.nextCursor).toBeUndefined();

        const nextCycle = await adapterA.pagination!.readPage({
            tag: 'fence',
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 10,
        }, { backendName: 'sql' });
        expect(nextCycle.items.map((item) => item.id)).toEqual(['fence:1', 'fence:2', 'fence:3']);
    });

    it('keeps UTC timestamp fences correct on a non-UTC database session', async () => {
        const timezoneTenant = `${prefix}-timezone`;
        const timezonePrisma = new PrismaClient({
            adapter: new PrismaPg({
                ...getSafePgConfig(DB_URL!),
                options: '-c TimeZone=Asia/Tokyo',
            }),
        });
        const timezoneAdapter = new MemorySQLAdapter({
            prismaClient: timezonePrisma,
            defaultTenantId: timezoneTenant,
            semanticCursorKey: CURSOR_KEY,
        });

        try {
            await timezoneAdapter.set('timezone:a', { state: 'ready' }, { tags: ['timezone'] });
            await timezoneAdapter.atomic.compareAndSet(
                { key: 'timezone:b', expectedVersion: null, value: { state: 'ready' } },
                { tags: ['timezone'] },
            );
            const page = await timezoneAdapter.pagination!.readPage({
                tag: 'timezone',
                orderBy: { path: 'createdAt', direction: 'asc' },
                limit: 10,
            }, { backendName: 'sql' });

            expect(page.items.map((item) => item.id).sort()).toEqual(['timezone:a', 'timezone:b']);
            expect(page.nextCursor).toBeUndefined();
        } finally {
            await client.query('DELETE FROM agent_memory_store WHERE tenant_id = $1', [timezoneTenant]);
            await timezonePrisma.$disconnect();
        }
    });

    it('paginates updatedAt descending and preserves the same-direction key tie break', async () => {
        await client.query(`
            INSERT INTO agent_memory_store
                (tenant_id, key, value, tags, created_at, updated_at)
            VALUES
                ($1, 'descending:a', '{"rank": 1}'::jsonb, ARRAY['descending']::text[], TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01 00:00:01'),
                ($1, 'descending:b', '{"rank": 2}'::jsonb, ARRAY['descending']::text[], TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01 00:00:02'),
                ($1, 'descending:c', '{"rank": 3}'::jsonb, ARRAY['descending']::text[], TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01 00:00:02'),
                ($1, 'descending:d', '{"rank": 4}'::jsonb, ARRAY['descending']::text[], TIMESTAMP '2026-02-01', TIMESTAMP '2026-02-01 00:00:03')
        `, [tenantA]);

        let cursor: string | undefined;
        const ids: string[] = [];
        do {
            const page = await adapterA.pagination!.readPage({
                tag: 'descending',
                orderBy: { path: 'updatedAt', direction: 'desc' },
                limit: 2,
                ...(cursor ? { cursor } : {}),
            }, { backendName: 'sql' });
            ids.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor;
        } while (cursor);

        expect(ids).toEqual(['descending:d', 'descending:c', 'descending:b', 'descending:a']);
    });

    it('keeps forward progress when unseen rows are deleted or leave the tag set', async () => {
        for (const key of ['mutation:a', 'mutation:b', 'mutation:c', 'mutation:d']) {
            await adapterA.set(key, { state: 'ready' }, { tags: ['mutation', 'ready'] });
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        const first = await adapterA.pagination!.readPage({
            tags: ['mutation', 'ready'],
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 2,
        }, { backendName: 'sql' });

        await adapterA.delete('mutation:c');
        await adapterA.set('mutation:d', { state: 'claimed' }, { tags: ['mutation', 'claimed'] });
        const rest = await adapterA.pagination!.readPage({
            tags: ['mutation', 'ready'],
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 10,
            cursor: first.nextCursor!,
        }, { backendName: 'sql' });

        expect([...first.items, ...rest.items].map((item) => item.id)).toEqual(['mutation:a', 'mutation:b']);
        expect(rest.nextCursor).toBeUndefined();
        await expect(adapterA.getMany({ tags: ['mutation', 'claimed'] }))
            .resolves.toMatchObject([{ key: 'mutation:d' }]);
    });

    it('handles empty, one-row, exact-final, and maximum-limit page boundaries', async () => {
        await expect(adapterA.pagination!.readPage({
            tag: 'boundary:missing',
            limit: 1,
        }, { backendName: 'sql' })).resolves.toEqual({ items: [] });

        await adapterA.set('boundary:a', { state: 'ready' }, { tags: ['boundary'] });
        await adapterA.set('boundary:b', { state: 'ready' }, { tags: ['boundary'] });
        const first = await adapterA.pagination!.readPage({
            tag: 'boundary',
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 1,
        }, { backendName: 'sql' });
        expect(first.items.map((item) => item.id)).toEqual(['boundary:a']);
        expect(first.nextCursor).toBeDefined();

        const exactFinal = await adapterA.pagination!.readPage({
            tag: 'boundary',
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 1,
            cursor: first.nextCursor!,
        }, { backendName: 'sql' });
        expect(exactFinal.items.map((item) => item.id)).toEqual(['boundary:b']);
        expect(exactFinal.nextCursor).toBeUndefined();

        const maximum = await adapterA.pagination!.readPage({
            tag: 'boundary',
            orderBy: { path: 'createdAt', direction: 'asc' },
            limit: 10_000,
        }, { backendName: 'sql' });
        expect(maximum.items.map((item) => item.id)).toEqual(['boundary:a', 'boundary:b']);
        expect(maximum.nextCursor).toBeUndefined();
    });

    it('fences an updatedAt cycle when an unseen row changes and includes it in the next cycle', async () => {
        for (const key of ['updated-mutation:a', 'updated-mutation:b', 'updated-mutation:c']) {
            await adapterA.set(key, { state: 'ready' }, { tags: ['updated-mutation'] });
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const first = await adapterA.pagination!.readPage({
            tag: 'updated-mutation',
            orderBy: { path: 'updatedAt', direction: 'asc' },
            limit: 1,
        }, { backendName: 'sql' });
        expect(first.items.map((item) => item.id)).toEqual(['updated-mutation:a']);

        await new Promise((resolve) => setTimeout(resolve, 5));
        await adapterA.set('updated-mutation:b', { state: 'changed' }, { tags: ['updated-mutation'] });
        const remainder = await adapterA.pagination!.readPage({
            tag: 'updated-mutation',
            orderBy: { path: 'updatedAt', direction: 'asc' },
            limit: 10,
            cursor: first.nextCursor!,
        }, { backendName: 'sql' });
        expect(remainder.items.map((item) => item.id)).toEqual(['updated-mutation:c']);
        expect(remainder.nextCursor).toBeUndefined();

        const nextCycle = await adapterA.pagination!.readPage({
            tag: 'updated-mutation',
            orderBy: { path: 'updatedAt', direction: 'asc' },
            limit: 10,
        }, { backendName: 'sql' });
        expect(nextCycle.items.map((item) => item.id))
            .toEqual(['updated-mutation:a', 'updated-mutation:c', 'updated-mutation:b']);
    });
});
