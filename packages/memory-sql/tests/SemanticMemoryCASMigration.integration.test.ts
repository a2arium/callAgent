import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const DB_URL = process.env.MEMORY_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

describeIfDb('semantic CAS migration', () => {
    const schema = `cas_migration_${Date.now()}`;
    let client: pg.Client;

    beforeAll(async () => {
        client = new pg.Client({ connectionString: DB_URL });
        await client.connect();
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}"`);
        await client.query(`
            CREATE TABLE agent_memory_store (
                tenant_id text NOT NULL,
                key text NOT NULL,
                value jsonb NOT NULL,
                tags text[] NOT NULL DEFAULT '{}',
                created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at timestamp(3) NOT NULL,
                PRIMARY KEY (tenant_id, key)
            )
        `);
        await client.query(`
            INSERT INTO agent_memory_store (tenant_id, key, value, updated_at)
            VALUES ('tenant', 'a', '{"n":1}', NOW()), ('tenant', 'b', '{"n":2}', NOW())
        `);
        const migration = await readFile(
            new URL('../prisma/migrations/20260712120000_semantic_memory_cas/migration.sql', import.meta.url),
            'utf8'
        );
        await client.query(migration);
    });

    afterAll(async () => {
        if (!client) return;
        await client.query('RESET search_path');
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
    });

    it('backfills distinct versions without changing values', async () => {
        const result = await client.query('SELECT key, value, version FROM agent_memory_store ORDER BY key');
        expect(result.rows.map((row) => row.value)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(result.rows[0].version).not.toBe(result.rows[1].version);
        expect(result.rows.every((row) => /^[1-9][0-9]*$/.test(String(row.version)))).toBe(true);
    });

    it('bumps updates and does not reuse a generation after delete/recreate', async () => {
        const before = await client.query("SELECT version FROM agent_memory_store WHERE key = 'a'");
        await client.query("UPDATE agent_memory_store SET value = '{\"n\":3}' WHERE key = 'a'");
        const updated = await client.query("SELECT version FROM agent_memory_store WHERE key = 'a'");
        expect(updated.rows[0].version).not.toBe(before.rows[0].version);

        await client.query("DELETE FROM agent_memory_store WHERE key = 'a'");
        await client.query("INSERT INTO agent_memory_store (tenant_id, key, value, updated_at) VALUES ('tenant', 'a', '{\"n\":4}', NOW())");
        const recreated = await client.query("SELECT version FROM agent_memory_store WHERE key = 'a'");
        expect(recreated.rows[0].version).not.toBe(updated.rows[0].version);
        expect(recreated.rows[0].version).not.toBe(before.rows[0].version);
    });

    it('does not publish a new stored generation when an update rolls back', async () => {
        const before = await client.query("SELECT value, version FROM agent_memory_store WHERE key = 'b'");
        await client.query('BEGIN');
        await client.query("UPDATE agent_memory_store SET value = '{\"n\":99}' WHERE key = 'b'");
        await client.query('ROLLBACK');
        const after = await client.query("SELECT value, version FROM agent_memory_store WHERE key = 'b'");
        expect(after.rows[0]).toEqual(before.rows[0]);
    });
});
