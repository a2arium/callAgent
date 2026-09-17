import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffoldAgent } from '../../src/scaffold/scaffoldAgent.js';

describe('scaffoldAgent minimal', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplret-min-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('writes expected files', async () => {
        const result = await scaffoldAgent({
            name: 'demo-agent',
            preset: 'minimal',
            outputDir: dir,
            monorepo: false,
        });
        expect(result.filesCreated).toEqual(
            expect.arrayContaining([
                'agent-card.json',
                'agent-runtime.json',
                'package.json',
                'tsconfig.json',
                'types.ts',
                'attention.ts',
                'perception.ts',
                'learning.ts',
                'policy.ts',
                'shield.ts',
                'execution.ts',
                'transition.ts',
                'agent.ts',
                'tests/golden.test.ts',
            ])
        );
    });
});
