import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const DB_URL = process.env.MEMORY_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

describeIfDb('semantic tag null hardening', () => {
    const schema = `tag_backfill_${Date.now()}`;
    let admin: pg.Client;

    beforeAll(async () => {
        admin = new pg.Client({ connectionString: DB_URL });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await admin.query(`
            CREATE TABLE "${schema}".agent_memory_store (
                tenant_id text NOT NULL,
                key text NOT NULL,
                tags text[],
                PRIMARY KEY (tenant_id, key)
            )
        `);
    });

    afterAll(async () => {
        if (!admin) return;
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
    });

    it('checkpoints a bounded batch and resumes without revisiting completed rows', async () => {
        await admin.query(`
            INSERT INTO "${schema}".agent_memory_store (tenant_id, key, tags)
            SELECT 'tenant-' || (generated % 3), 'key-' || lpad(generated::text, 5, '0'), NULL
            FROM generate_series(1, 25) AS generated
        `);
        // The script is JavaScript by design so operators can run it without a TypeScript loader.
        const { backfillSemanticTags } = await import('../scripts/semantic-tags-backfill.mjs' as string) as {
            backfillSemanticTags: (options: Record<string, unknown>) => Promise<{
                completed: boolean; processedRows: number; batches: number;
            }>;
        };

        const paused = await backfillSemanticTags({
            databaseUrl: DB_URL,
            schema,
            batchSize: 10,
            maxBatches: 1,
            log: () => undefined,
        });
        expect(paused).toEqual({ completed: false, processedRows: 10, batches: 1 });
        await expect(admin.query(`SELECT count(*)::int AS count FROM "${schema}".agent_memory_store WHERE tags IS NULL`))
            .resolves.toMatchObject({ rows: [{ count: 15 }] });

        const resumed = await backfillSemanticTags({
            databaseUrl: DB_URL,
            schema,
            batchSize: 7,
            log: () => undefined,
        });
        expect(resumed).toMatchObject({ completed: true, processedRows: 25 });
        const progress = await admin.query(`
            SELECT processed_rows::int, completed
            FROM "${schema}".callagent_migration_progress
        `);
        expect(progress.rows).toEqual([{ processed_rows: 25, completed: true }]);
    });

    it('aborts above the automatic threshold, then succeeds after resumable operator backfill', async () => {
        await admin.query(`TRUNCATE "${schema}".agent_memory_store, "${schema}".callagent_migration_progress`);
        await admin.query(`
            INSERT INTO "${schema}".agent_memory_store (tenant_id, key, tags)
            SELECT 'large', 'key-' || lpad(generated::text, 5, '0'), NULL
            FROM generate_series(1, 10001) AS generated
        `);
        const migration = await readFile(
            new URL('../prisma/migrations/20260718110000_semantic_tags_not_null/migration.sql', import.meta.url),
            'utf8'
        );
        await admin.query(`SET search_path TO "${schema}"`);
        await expect(admin.query(migration)).rejects.toThrow(/operator batching/);

        const { backfillSemanticTags } = await import('../scripts/semantic-tags-backfill.mjs' as string) as any;
        await expect(backfillSemanticTags({
            databaseUrl: DB_URL,
            schema,
            batchSize: 1000,
            log: () => undefined,
        })).resolves.toMatchObject({ completed: true, processedRows: 10001 });

        await expect(admin.query(migration)).resolves.toBeDefined();
        const invariant = await admin.query(`
            SELECT is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'agent_memory_store' AND column_name = 'tags'
        `, [schema]);
        expect(invariant.rows[0]).toMatchObject({ is_nullable: 'NO' });
        expect(invariant.rows[0].column_default).toContain('ARRAY[]');
    }, 60_000);

    it('fails closed on a wrong-definition collision and recovers an interrupted concurrent build', async () => {
        const indexSql = await readFile(
            new URL('../prisma/migrations/20260718120000_semantic_tags_gin_concurrent/migration.sql', import.meta.url),
            'utf8'
        );
        await admin.query(`DROP INDEX IF EXISTS "${schema}".agent_memory_store_tags_gin_idx`);
        await admin.query(`
            CREATE INDEX agent_memory_store_tags_gin_idx
            ON "${schema}".agent_memory_store USING btree (tags)
        `);
        await admin.query(`SET search_path TO "${schema}"`);
        await expect(admin.query(indexSql)).rejects.toThrow(/already exists/);
        const collision = await admin.query(`
            SELECT am.amname AS access_method
            FROM pg_index AS index
            JOIN pg_class AS relation ON relation.oid = index.indexrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            JOIN pg_am AS am ON am.oid = relation.relam
            WHERE namespace.nspname = $1 AND relation.relname = 'agent_memory_store_tags_gin_idx'
        `, [schema]);
        expect(collision.rows).toEqual([{ access_method: 'btree' }]);
        await admin.query(`DROP INDEX "${schema}".agent_memory_store_tags_gin_idx`);

        const blocker = new pg.Client({ connectionString: DB_URL });
        const builder = new pg.Client({ connectionString: DB_URL });
        await blocker.connect();
        await builder.connect();
        try {
            await blocker.query(`SET search_path TO "${schema}"`);
            await blocker.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            await blocker.query('SELECT count(*) FROM agent_memory_store');
            await builder.query(`SET search_path TO "${schema}"`);
            const builderPid = Number((await builder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
            const build = builder.query(indexSql);

            let observedInvalid = false;
            for (let attempt = 0; attempt < 200; attempt++) {
                const state = await admin.query(`
                    SELECT index.indisvalid AS valid
                    FROM pg_index AS index
                    JOIN pg_class AS relation ON relation.oid = index.indexrelid
                    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                    WHERE namespace.nspname = $1 AND relation.relname = 'agent_memory_store_tags_gin_idx'
                `, [schema]);
                if (state.rows.length > 0 && state.rows[0].valid === false) {
                    observedInvalid = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(observedInvalid).toBe(true);
            await admin.query('SELECT pg_cancel_backend($1)', [builderPid]);
            await expect(build).rejects.toThrow(/canceling statement/);
            await blocker.query('COMMIT');

            const invalid = await admin.query(`
                SELECT index.indisvalid AS valid, index.indisready AS ready
                FROM pg_index AS index
                JOIN pg_class AS relation ON relation.oid = index.indexrelid
                JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = $1 AND relation.relname = 'agent_memory_store_tags_gin_idx'
            `, [schema]);
            expect(invalid.rows[0]).toMatchObject({ valid: false });

            await admin.query(`DROP INDEX CONCURRENTLY "${schema}".agent_memory_store_tags_gin_idx`);
            await expect(builder.query(indexSql)).resolves.toBeDefined();
            const recovered = await admin.query(`
                SELECT index.indisvalid AS valid, index.indisready AS ready, am.amname AS access_method
                FROM pg_index AS index
                JOIN pg_class AS relation ON relation.oid = index.indexrelid
                JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                JOIN pg_am AS am ON am.oid = relation.relam
                WHERE namespace.nspname = $1 AND relation.relname = 'agent_memory_store_tags_gin_idx'
            `, [schema]);
            expect(recovered.rows).toEqual([{ valid: true, ready: true, access_method: 'gin' }]);
        } finally {
            await blocker.query('ROLLBACK').catch(() => undefined);
            await blocker.end();
            await builder.end();
        }
    }, 60_000);
});
