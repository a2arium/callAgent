import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import pg from 'pg';

const DB_URL = process.env.MEMORY_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

describeIfDb('semantic tag representative query plan', () => {
    const prefix = `tag-plan-${Date.now()}`;
    const primaryTenant = `${prefix}-primary`;
    let client: pg.Client;

    beforeAll(async () => {
        client = new pg.Client({ connectionString: DB_URL });
        await client.connect();
        await client.query(`
            INSERT INTO agent_memory_store
                (tenant_id, key, value, tags, created_at, updated_at)
            SELECT
                $1,
                $2 || ':' || generated::text,
                jsonb_build_object('fixture', generated),
                CASE
                    WHEN generated % 1000 = 0 THEN ARRAY['plan:rare', 'plan:medium', 'plan:common']::text[]
                    WHEN generated % 100 = 0 THEN ARRAY['plan:medium', 'plan:common']::text[]
                    WHEN generated % 4 = 0 THEN ARRAY['plan:common']::text[]
                    ELSE ARRAY[]::text[]
                END,
                clock_timestamp(),
                clock_timestamp()
            FROM generate_series(1, 100000) AS generated
        `, [primaryTenant, prefix]);
        await client.query(`
            INSERT INTO agent_memory_store
                (tenant_id, key, value, tags, created_at, updated_at)
            SELECT
                $1 || '-tenant-' || generated::text,
                $1 || '-tenant-row',
                '{}'::jsonb,
                ARRAY['plan:distribution']::text[],
                clock_timestamp(),
                clock_timestamp()
            FROM generate_series(1, 100) AS generated
        `, [prefix]);
        await client.query('ANALYZE agent_memory_store');
    }, 60_000);

    afterAll(async () => {
        if (!client) return;
        await client.query('DELETE FROM agent_memory_store WHERE tenant_id = $1 OR tenant_id LIKE $2', [primaryTenant, `${prefix}-tenant-%`]);
        await client.end();
    }, 60_000);

    it('uses the canonical GIN index for a selective tenant-scoped all-of query', async () => {
        const result = await client.query(`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT key, value, tags
            FROM agent_memory_store
            WHERE tenant_id = $1
              AND tags @> $2::text[]
            ORDER BY updated_at DESC, key ASC
            LIMIT $3
        `, [primaryTenant, ['plan:rare'], 100]);
        const plan = result.rows[0]['QUERY PLAN'][0];
        const serialized = JSON.stringify(plan);
        expect(serialized).toContain('agent_memory_store_tags_gin_idx');
        expect(serialized).toContain('plan:rare');
        expect(serialized).toContain(primaryTenant);
        expect(plan.Plan['Node Type']).toBe('Limit');
        expect(plan['Execution Time']).toBeGreaterThanOrEqual(0);
    });
});
