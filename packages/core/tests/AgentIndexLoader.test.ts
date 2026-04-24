import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgentIndex } from '../src/plugin/AgentIndexLoader.js';

describe('AgentIndexLoader TypeScript runtime guard', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('warns clearly when index points to .ts module in plain node runtime', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callagent-index-loader-'));
        const tsAgentPath = path.join(root, 'source-only-agent.ts');
        const indexPath = path.join(root, '.callagent', 'agent-paths.json');

        fs.mkdirSync(path.dirname(indexPath), { recursive: true });
        fs.writeFileSync(tsAgentPath, 'export const agent = {};', 'utf8');
        fs.writeFileSync(
            indexPath,
            JSON.stringify({
                'source-only-agent-test-does-not-exist': {
                    module: '../source-only-agent.ts'
                }
            }),
            'utf8'
        );

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await loadAgentIndex({
            cwd: root,
            indexPath: '.callagent/agent-paths.json',
            silent: false
        });

        expect(result.loaded).toEqual([]);
        expect(result.skipped).toContain('source-only-agent-test-does-not-exist');
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('[AgentIndexLoader] Agent index points to a TypeScript module that this runtime cannot import directly.'),
            expect.objectContaining({
                agentName: 'source-only-agent-test-does-not-exist',
                modulePath: expect.stringContaining('source-only-agent.ts')
            })
        );

        fs.rmSync(root, { recursive: true, force: true });
    });

    test('handles mixed legacy/structured index and skips malformed entries', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callagent-index-loader-mixed-'));
        const tsAgentPath = path.join(root, 'source-only-agent.ts');
        const indexPath = path.join(root, '.callagent', 'agent-paths.json');

        fs.mkdirSync(path.dirname(indexPath), { recursive: true });
        fs.writeFileSync(tsAgentPath, 'export const agent = {};', 'utf8');
        fs.writeFileSync(
            indexPath,
            JSON.stringify({
                'legacy-agent': '../source-only-agent.ts',
                'structured-agent': { module: '../source-only-agent.ts', agentCard: null, runtimeManifest: null },
                'broken-agent': 42
            }),
            'utf8'
        );

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await loadAgentIndex({
            cwd: root,
            indexPath: '.callagent/agent-paths.json',
            silent: false
        });

        expect(result.loaded).toEqual([]);
        expect(result.skipped).toEqual(expect.arrayContaining(['legacy-agent', 'structured-agent', 'broken-agent']));
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('[AgentIndexLoader] Skipping malformed agent index entry.'),
            expect.objectContaining({
                agentName: 'broken-agent',
                entryType: 'number'
            })
        );

        fs.rmSync(root, { recursive: true, force: true });
    });
});
