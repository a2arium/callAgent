import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffoldAgent } from '../../src/scaffold/scaffoldAgent.js';

describe('scaffold flow.md', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplret-flow-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('has YAML front matter and canonical headings', async () => {
        await scaffoldAgent({
            name: 'flow-agent',
            preset: 'non-trivial',
            outputDir: dir,
            monorepo: false,
        });
        const md = fs.readFileSync(path.join(dir, 'flow.md'), 'utf8');
        expect(md.startsWith('---\n')).toBe(true);
        expect(md).toContain('entry: ./agent.ts');
        expect(md).toContain('# Flow: flow-agent');
        expect(md).toContain('## Purpose');
        expect(md).toContain('## Flow summary');
        expect(md).toContain('## Branches and failure paths');
        expect(md).toContain('### B1:');
    });
});
