import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffoldAgent } from '../../src/scaffold/scaffoldAgent.js';

describe('scaffold manifests', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplret-man-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('agent-card and agent-runtime share name and version', async () => {
        await scaffoldAgent({
            name: 'demo-agent',
            preset: 'minimal',
            outputDir: dir,
            monorepo: false,
        });
        const card = JSON.parse(fs.readFileSync(path.join(dir, 'agent-card.json'), 'utf8')) as {
            name: string;
            version: string;
        };
        const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'agent-runtime.json'), 'utf8')) as {
            name: string;
            version: string;
        };
        expect(card.name).toBe(runtime.name);
        expect(card.version).toBe(runtime.version);
        expect(card.name).toBe('demo-agent');
    });
});
