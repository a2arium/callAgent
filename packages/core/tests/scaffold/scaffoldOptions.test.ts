import { describe, expect, test } from '@jest/globals';
import { ScaffoldOptionsSchema } from '../../src/scaffold/types.js';

describe('ScaffoldOptionsSchema', () => {
    test('accepts minimal valid options', () => {
        const r = ScaffoldOptionsSchema.safeParse({
            name: 'my-agent',
            preset: 'minimal',
            outputDir: './out',
        });
        expect(r.success).toBe(true);
    });

    test('accepts snake_case name', () => {
        const r = ScaffoldOptionsSchema.safeParse({
            name: 'my_agent',
            preset: 'non-trivial',
            outputDir: 'apps/examples/foo',
        });
        expect(r.success).toBe(true);
    });

    test('rejects invalid name', () => {
        const r = ScaffoldOptionsSchema.safeParse({
            name: 'MyAgent',
            preset: 'minimal',
            outputDir: './out',
        });
        expect(r.success).toBe(false);
    });

    test('rejects extra keys (strict)', () => {
        const r = ScaffoldOptionsSchema.safeParse({
            name: 'x',
            preset: 'minimal',
            outputDir: './out',
            extra: 1,
        });
        expect(r.success).toBe(false);
    });
});
