import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import pg from 'pg';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';

const DB_URL = process.env.MEMORY_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

describeIfDb('semantic tag queries and transitions', () => {
    const tenantA = `tag-query-a-${Date.now()}`;
    const tenantB = `tag-query-b-${Date.now()}`;
    let a: MemorySQLAdapter;
    let b: MemorySQLAdapter;

    beforeAll(async () => {
        a = new MemorySQLAdapter({ databaseUrl: DB_URL!, defaultTenantId: tenantA });
        b = new MemorySQLAdapter({ databaseUrl: DB_URL!, defaultTenantId: tenantB });
    });

    afterAll(async () => {
        for (const adapter of [a, b]) {
            if (!adapter) continue;
            for (const row of await adapter.getMany('*', { limit: 10_000 })) {
                await adapter.delete(row.key);
            }
            await adapter.disconnect();
        }
    });

    it('applies all tags and JSON filters before ordering and limit', async () => {
        await a.set('older:true-match', { state: 'ready', priority: 7 }, { tags: [' Alpha ', 'BETA', 'site:42'] });
        await a.set('newer:a-only', { state: 'ready', priority: 9 }, { tags: ['alpha'] });
        await a.set('newest:wrong-state', { state: 'draft', priority: 10 }, { tags: ['alpha', 'beta'] });

        const allOf = await a.getMany({ tag: 'ALPHA', tags: [' beta ', 'alpha'], limit: 1 });
        expect(allOf.map((row) => row.key)).toEqual(['newest:wrong-state']);
        expect(allOf[0]?.tags).toEqual(['alpha', 'beta']);

        const filtered = await a.getMany({
            tags: ['alpha', 'beta'],
            filters: [{ path: 'state', operator: '=', value: 'ready' }],
            limit: 1,
        });
        expect(filtered.map((row) => row.key)).toEqual(['older:true-match']);
        expect(filtered[0]?.tags).toEqual(['alpha', 'beta', 'site:42']);
    });

    it('returns stored tags on pattern and random paths while preserving tenant isolation', async () => {
        await b.set('older:true-match', { state: 'ready' }, { tags: ['alpha', 'beta', 'tenant:b'] });

        const pattern = await a.getMany('older:*', { limit: 5 });
        expect(pattern).toHaveLength(1);
        expect(pattern[0]?.tags).toEqual(['alpha', 'beta', 'site:42']);

        const random = await a.getMany({ tags: ['alpha', 'beta'], random: true, limit: 10 });
        expect(random.length).toBeGreaterThan(0);
        expect(random.every((row) => row.tags?.includes('alpha') && row.tags.includes('beta'))).toBe(true);
        expect(random.every((row) => !row.tags?.includes('tenant:b'))).toBe(true);
    });

    it('honors strict structured removal limit and keeps other tenants untouched', async () => {
        await a.set('remove:1', { state: 'expired' }, { tags: ['proposal', 'expired'] });
        await a.set('remove:2', { state: 'active' }, { tags: ['proposal', 'expired'] });
        await b.set('remove:1', { state: 'expired' }, { tags: ['proposal', 'expired'] });

        await expect(a.deleteMany({
            tags: ['proposal', 'expired'],
            filters: [{ path: 'state', operator: '=', value: 'expired' }],
            limit: 1,
        })).resolves.toBe(1);
        await expect(a.getMany({ tags: ['proposal', 'expired'] })).resolves.toHaveLength(1);
        await expect(a.getMany({
            tags: ['proposal', 'expired'],
            filters: [{ path: 'state', operator: '=', value: 'active' }],
        })).resolves.toHaveLength(1);
        await expect(b.getMany({ tags: ['proposal', 'expired'] })).resolves.toHaveLength(1);
    });

    it('changes value and replacement tag set as one CAS pair with one concurrent winner', async () => {
        await a.set('claim:1', { state: 'queued' }, { tags: ['record:test', 'state:queued'] });
        const before = await a.getVersioned<{ state: string }>('claim:1');
        expect(before).not.toBeNull();

        const attempts = await Promise.all([
            a.compareAndSet(
                { key: 'claim:1', expectedVersion: before!.version, value: { state: 'claimed', winner: 'a' } },
                { tags: ['record:test', 'state:claimed', 'winner:a'] }
            ),
            a.compareAndSet(
                { key: 'claim:1', expectedVersion: before!.version, value: { state: 'claimed', winner: 'b' } },
                { tags: ['record:test', 'state:claimed', 'winner:b'] }
            ),
        ]);
        expect(attempts.filter((result) => result.status === 'updated')).toHaveLength(1);
        expect(attempts.filter((result) => result.status === 'conflict')).toHaveLength(1);
        await expect(a.getMany({ tags: ['record:test', 'state:queued'] })).resolves.toHaveLength(0);
        const claimed = await a.getMany<{ state: string; winner: string }>({ tags: ['record:test', 'state:claimed'] });
        expect(claimed).toHaveLength(1);
        expect(claimed[0]?.tags).toContain(`winner:${claimed[0]?.value.winner}`);
        await expect(b.getMany({ tags: ['record:test', 'state:claimed'] })).resolves.toHaveLength(0);
    });

    it('rechecks the predicate after waiting for a concurrent tag transition', async () => {
        await a.set('remove-race:1', { state: 'ready' }, { tags: ['remove-race', 'state:ready'] });
        const updater = new pg.Client({ connectionString: DB_URL });
        await updater.connect();
        await updater.query('BEGIN');
        await updater.query(`
            UPDATE agent_memory_store
            SET tags = ARRAY['remove-race', 'state:claimed']::text[]
            WHERE tenant_id = $1 AND key = 'remove-race:1'
        `, [tenantA]);

        const removal = a.deleteMany({ tags: ['remove-race', 'state:ready'], limit: 1 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await updater.query('COMMIT');
        await updater.end();

        await expect(removal).resolves.toBe(0);
        await expect(a.getMany({ tags: ['remove-race', 'state:claimed'] }))
            .resolves.toMatchObject([{ key: 'remove-race:1' }]);
    });

    it('uses canonical lock order for overlapping opposite-priority removers', async () => {
        await a.set('remove-order:a', {}, { tags: ['remove-order'] });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await a.set('remove-order:b', {}, { tags: ['remove-order'] });

        const [oldestFirst, newestFirst] = await Promise.all([
            a.deleteMany({ tag: 'remove-order', orderBy: { path: 'createdAt', direction: 'asc' }, limit: 2 }),
            a.deleteMany({ tag: 'remove-order', orderBy: { path: 'createdAt', direction: 'desc' }, limit: 2 }),
        ]);
        expect(oldestFirst + newestFirst).toBe(2);
        await expect(a.getMany({ tag: 'remove-order' })).resolves.toHaveLength(0);
    });

    it('rolls back memory deletion when alignment cleanup fails', async () => {
        const suffix = Date.now().toString();
        const functionName = `fail_alignment_cleanup_${suffix}`;
        const triggerName = `fail_alignment_cleanup_${suffix}`;
        const admin = new pg.Client({ connectionString: DB_URL });
        await admin.connect();
        await a.set('remove-rollback:1', {}, { tags: ['remove-rollback'] });
        try {
            await admin.query(`
                INSERT INTO entity_store
                    (id, entity_type, canonical_name, aliases, embedding, tenant_id, updated_at)
                VALUES ($1, 'test', $2, ARRAY[]::text[], array_fill(0::real, ARRAY[1536])::vector, $3, clock_timestamp())
            `, [`entity-${suffix}`, `entity-${suffix}`, tenantA]);
            await admin.query(`
                INSERT INTO entity_alignment
                    (id, memory_key, field_path, entity_id, original_value, confidence, tenant_id)
                VALUES ($1, 'remove-rollback:1', 'venue', $2, 'venue', 'high', $3)
            `, [`alignment-${suffix}`, `entity-${suffix}`, tenantA]);
            await expect(a.getMany({
                filters: [{ path: 'venue', operator: 'ENTITY_EXACT', value: `entity-${suffix}` }],
            })).resolves.toMatchObject([{ key: 'remove-rollback:1' }]);
            await expect(a.getMany({
                filters: [{ path: 'venue', operator: 'ENTITY_FUZZY', value: `entity-${suffix}` }],
            })).resolves.toMatchObject([{ key: 'remove-rollback:1' }]);
            await admin.query(`
                CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'forced alignment cleanup failure';
                END $$
            `);
            await admin.query(`
                CREATE TRIGGER "${triggerName}"
                BEFORE DELETE ON entity_alignment
                FOR EACH ROW
                WHEN (OLD.tenant_id = '${tenantA}')
                EXECUTE FUNCTION "${functionName}"()
            `);

            await expect(a.deleteMany({ tag: 'remove-rollback', limit: 1 }))
                .rejects.toThrow(/forced alignment cleanup failure/);
            await expect(a.getMany({ tag: 'remove-rollback' }))
                .resolves.toMatchObject([{ key: 'remove-rollback:1' }]);
            const alignments = await admin.query(`
                SELECT count(*)::int AS count
                FROM entity_alignment
                WHERE tenant_id = $1 AND memory_key = 'remove-rollback:1'
            `, [tenantA]);
            expect(alignments.rows).toEqual([{ count: 1 }]);
        } finally {
            await admin.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON entity_alignment`);
            await admin.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
            await admin.query('DELETE FROM entity_alignment WHERE tenant_id = $1 AND memory_key = $2', [tenantA, 'remove-rollback:1']);
            await admin.query('DELETE FROM entity_store WHERE tenant_id = $1 AND id = $2', [tenantA, `entity-${suffix}`]);
            await admin.end();
        }
    });
});
