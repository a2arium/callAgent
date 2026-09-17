import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffoldAgent } from '../../src/scaffold/scaffoldAgent.js';

describe('scaffold generated types.ts', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplret-typ-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('has closed unions and no any', async () => {
        await scaffoldAgent({
            name: 'demo-agent',
            preset: 'minimal',
            outputDir: dir,
            monorepo: false,
        });
        const src = fs.readFileSync(path.join(dir, 'types.ts'), 'utf8');
        expect(src).toContain("export type Obs =");
        expect(src).toContain('export type AgentIntent =');
        expect(src).toContain('export type Stage =');
        expect(src).toContain("'user_message'");
        expect(src).not.toMatch(/\bany\b/);
    });
});
