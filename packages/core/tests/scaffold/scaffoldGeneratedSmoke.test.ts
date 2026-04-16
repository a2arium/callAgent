import { describe, test, expect, afterEach } from '@jest/globals';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldAgent } from '../../src/scaffold/scaffoldAgent.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

describe('scaffold generated smoke (tsc)', () => {
    let absOut: string | undefined;

    afterEach(() => {
        if (absOut && fs.existsSync(absOut)) {
            fs.rmSync(absOut, { recursive: true, force: true });
        }
        absOut = undefined;
    });

    test('minimal preset compiles with monorepo tsconfig under apps/examples', async () => {
        absOut = fs.mkdtempSync(path.join(repoRoot, 'apps/examples', 'scaffold-smoke-'));
        await scaffoldAgent({
            name: 'smoke-agent',
            preset: 'minimal',
            outputDir: absOut,
            description: 'smoke',
            force: true,
            monorepo: true,
        });
        const tsconfigPath = path.join(absOut, 'tsconfig.json');
        execSync(`yarn exec tsc --noEmit -p ${JSON.stringify(tsconfigPath)}`, {
            cwd: repoRoot,
            stdio: 'pipe',
        });
        expect(fs.existsSync(tsconfigPath)).toBe(true);
    }, 60_000);
});
