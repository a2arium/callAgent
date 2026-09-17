import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const extractLiteralKinds = (source: string): string[] => {
    const kinds = new Set<string>();
    const re = /kind:\s*z\.literal\('([^']+)'\)/g;
    let match: RegExpExecArray | null = re.exec(source);
    while (match) {
        kinds.add(match[1]);
        match = re.exec(source);
    }
    return [...kinds].sort();
};

describe('Intent kind parity (core vs memory-engine scaffold)', () => {
    it('extracts the same kind: z.literal member set from both files', () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const coreSrc = readFileSync(path.join(here, '../src/types/intent.ts'), 'utf8');
        const scaffoldSrc = readFileSync(
            path.join(here, '../../memory-engine/src/types/external/intent.ts'),
            'utf8'
        );
        expect(extractLiteralKinds(coreSrc)).toEqual(extractLiteralKinds(scaffoldSrc));
        expect(extractLiteralKinds(coreSrc)).toContain('execute_step');
    });
});
