import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';

describe('semantic tag migrations', () => {
    it('keeps the concurrent GIN build isolated and structurally canonical', async () => {
        const sql = await readFile(
            new URL('../prisma/migrations/20260718120000_semantic_tags_gin_concurrent/migration.sql', import.meta.url),
            'utf8'
        );
        expect(sql).toContain('CREATE INDEX CONCURRENTLY "agent_memory_store_tags_gin_idx"');
        expect(sql).toContain('USING GIN ("tags" array_ops)');
        expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|IF NOT EXISTS/i);
    });

    it('bounds automatic null hardening and installs the default/non-null invariant', async () => {
        const sql = await readFile(
            new URL('../prisma/migrations/20260718110000_semantic_tags_not_null/migration.sql', import.meta.url),
            'utf8'
        );
        expect(sql).toContain('null_rows > 10000');
        expect(sql).toContain('CHECK ("tags" IS NOT NULL) NOT VALID');
        expect(sql).toContain('VALIDATE CONSTRAINT');
        expect(sql).toContain('ALTER COLUMN "tags" SET NOT NULL');
        expect(sql).toContain('ALTER COLUMN "tags" SET DEFAULT ARRAY[]::text[]');
        expect(sql).toContain("SET lock_timeout = '5s'");
    });
});
