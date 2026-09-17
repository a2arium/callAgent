#!/usr/bin/env node
import pg from 'pg';

const connectionString = process.env.MEMORY_DATABASE_URL;
if (!connectionString) {
    process.stderr.write('MEMORY_DATABASE_URL is required\n');
    process.exitCode = 1;
} else {
    const pool = new pg.Pool({ connectionString });
    try {
        const { rows } = await pool.query(`
            SELECT
                ns.nspname AS schema,
                idx.relname AS index_name,
                i.indisvalid AS valid,
                i.indisready AS ready,
                am.amname AS access_method,
                pg_get_indexdef(i.indexrelid) AS definition,
                pg_get_expr(i.indexprs, i.indrelid) AS expression,
                pg_get_expr(i.indpred, i.indrelid) AS predicate,
                pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
                COALESCE(
                    jsonb_agg(att.attname ORDER BY ord.ordinality) FILTER (WHERE att.attname IS NOT NULL),
                    '[]'::jsonb
                ) AS columns,
                COALESCE(
                    jsonb_agg(opc.opcname ORDER BY ord.ordinality) FILTER (WHERE opc.opcname IS NOT NULL),
                    '[]'::jsonb
                ) AS operator_classes
            FROM pg_index i
            JOIN pg_class idx ON idx.oid = i.indexrelid
            JOIN pg_class tbl ON tbl.oid = i.indrelid
            JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
            JOIN pg_am am ON am.oid = idx.relam
            LEFT JOIN LATERAL unnest(i.indkey, i.indclass) WITH ORDINALITY
                AS ord(attnum, opclass_oid, ordinality) ON true
            LEFT JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = ord.attnum
            LEFT JOIN pg_opclass opc ON opc.oid = ord.opclass_oid
            WHERE tbl.relname = 'agent_memory_store'
              AND ns.nspname = current_schema()
              AND idx.relname IN ('agent_memory_store_tags_gin_idx', 'idx_memory_tenant_tags')
            GROUP BY ns.nspname, idx.relname, i.indisvalid, i.indisready, am.amname,
                     i.indexrelid, i.indexprs, i.indrelid, i.indpred
            ORDER BY ns.nspname, idx.relname
        `);

        const canonical = rows.find((row) => row.index_name === 'agent_memory_store_tags_gin_idx');
        let classification = 'absent';
        if (canonical) {
            const correctDefinition = canonical.access_method === 'gin'
                && canonical.expression === null
                && canonical.predicate === null
                && canonical.columns?.length === 1
                && canonical.columns[0] === 'tags'
                && canonical.operator_classes?.length === 1
                && canonical.operator_classes[0] === 'array_ops';
            classification = !correctDefinition
                ? 'name-collision-wrong-definition'
                : canonical.valid && canonical.ready
                    ? 'valid-canonical'
                    : 'invalid-canonical';
        }

        process.stdout.write(`${JSON.stringify({ classification, indexes: rows }, null, 2)}\n`);
        if (classification !== 'valid-canonical') process.exitCode = 2;
    } catch (error) {
        process.stderr.write(`Semantic tag index inspection failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}
