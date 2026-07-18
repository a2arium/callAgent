#!/usr/bin/env node

import pg from 'pg';
import { pathToFileURL } from 'node:url';

const MIGRATION_ID = '20260718110000_semantic_tags_not_null';

function positiveInteger(value, fallback, maximum) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
        throw new Error(`Expected an integer from 1 through ${maximum}`);
    }
    return parsed;
}

export async function backfillSemanticTags({
    databaseUrl = process.env.MEMORY_DATABASE_URL,
    batchSize = positiveInteger(process.env.SEMANTIC_TAG_BACKFILL_BATCH_SIZE, 1000, 10_000),
    maxBatches = process.env.SEMANTIC_TAG_BACKFILL_MAX_BATCHES === undefined
        ? Number.POSITIVE_INFINITY
        : positiveInteger(process.env.SEMANTIC_TAG_BACKFILL_MAX_BATCHES, 1, 1_000_000),
    log = console.log,
    schema,
} = {}) {
    if (!databaseUrl) throw new Error('MEMORY_DATABASE_URL is required');
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
        if (schema !== undefined) {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema name');
            await client.query(`SET search_path TO "${schema}"`);
        }
        await client.query(`
            CREATE TABLE IF NOT EXISTS callagent_migration_progress (
                migration_id text PRIMARY KEY,
                last_tenant_id text,
                last_key text,
                processed_rows bigint NOT NULL DEFAULT 0,
                completed boolean NOT NULL DEFAULT false,
                updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
            )
        `);
        await client.query(`
            INSERT INTO callagent_migration_progress (migration_id)
            VALUES ($1)
            ON CONFLICT (migration_id) DO NOTHING
        `, [MIGRATION_ID]);

        let batches = 0;
        while (batches < maxBatches) {
            await client.query('BEGIN');
            try {
                await client.query("SET LOCAL lock_timeout = '5s'");
                await client.query("SET LOCAL statement_timeout = '2min'");
                const checkpoint = await client.query(`
                    SELECT last_tenant_id, last_key, processed_rows
                    FROM callagent_migration_progress
                    WHERE migration_id = $1
                    FOR UPDATE
                `, [MIGRATION_ID]);
                const state = checkpoint.rows[0];
                const updated = await client.query(`
                    WITH candidates AS (
                        SELECT tenant_id, key
                        FROM agent_memory_store
                        WHERE tags IS NULL
                          AND (
                              $1::text IS NULL
                              OR (tenant_id, key) > ($1::text, $2::text)
                          )
                        ORDER BY tenant_id ASC, key ASC
                        LIMIT $3
                        FOR UPDATE
                    ), changed AS (
                        UPDATE agent_memory_store AS memory
                        SET tags = ARRAY[]::text[]
                        FROM candidates
                        WHERE memory.tenant_id = candidates.tenant_id
                          AND memory.key = candidates.key
                          AND memory.tags IS NULL
                        RETURNING memory.tenant_id, memory.key
                    )
                    SELECT tenant_id, key
                    FROM changed
                    ORDER BY tenant_id ASC, key ASC
                `, [state.last_tenant_id, state.last_key, batchSize]);

                if (updated.rows.length === 0) {
                    const remaining = await client.query('SELECT count(*)::bigint AS count FROM agent_memory_store WHERE tags IS NULL');
                    const remainingCount = Number(remaining.rows[0].count);
                    if (remainingCount > 0) {
                        await client.query(`
                            UPDATE callagent_migration_progress
                            SET last_tenant_id = NULL, last_key = NULL, updated_at = clock_timestamp()
                            WHERE migration_id = $1
                        `, [MIGRATION_ID]);
                        await client.query('COMMIT');
                        continue;
                    }
                    await client.query(`
                        UPDATE callagent_migration_progress
                        SET completed = true, updated_at = clock_timestamp()
                        WHERE migration_id = $1
                    `, [MIGRATION_ID]);
                    await client.query('COMMIT');
                    log(JSON.stringify({ migrationId: MIGRATION_ID, completed: true, processedRows: Number(state.processed_rows) }));
                    return { completed: true, processedRows: Number(state.processed_rows), batches };
                }

                const last = updated.rows.at(-1);
                await client.query(`
                    UPDATE callagent_migration_progress
                    SET last_tenant_id = $2,
                        last_key = $3,
                        processed_rows = processed_rows + $4,
                        completed = false,
                        updated_at = clock_timestamp()
                    WHERE migration_id = $1
                `, [MIGRATION_ID, last.tenant_id, last.key, updated.rows.length]);
                await client.query('COMMIT');
                batches++;
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }

        const progress = await client.query(`
            SELECT processed_rows FROM callagent_migration_progress WHERE migration_id = $1
        `, [MIGRATION_ID]);
        const processedRows = Number(progress.rows[0]?.processed_rows ?? 0);
        log(JSON.stringify({ migrationId: MIGRATION_ID, completed: false, processedRows, batches }));
        return { completed: false, processedRows, batches };
    } finally {
        await client.end();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    backfillSemanticTags().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
