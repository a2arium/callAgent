import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAgentIndex } from '../src/plugin/AgentIndexBuilder.js';
import { SmartAgentDiscoveryService } from '../src/plugin/dependencies/SmartAgentDiscoveryService.js';

describe('AgentIndexBuilder source fallback', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'callagent-agent-index-'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('includes source-only .ts agent module when allowSourceFallback is enabled', async () => {
        const agentDir = path.join(tempRoot, 'source-only-agent');
        fs.mkdirSync(agentDir, { recursive: true });
        const agentModulePath = path.join(agentDir, 'agent.ts');
        const cardPath = path.join(agentDir, 'agent-card.json');

        fs.writeFileSync(agentModulePath, 'export const SourceOnlyAgent = {};', 'utf8');
        fs.writeFileSync(cardPath, JSON.stringify({ name: 'source-only-agent', version: '1.0.0' }), 'utf8');

        jest.spyOn(SmartAgentDiscoveryService, 'listAvailableAgents').mockResolvedValue([
            {
                name: 'source-only-agent',
                agentPath: agentModulePath,
                agentCardPath: cardPath,
                runtimeManifestPath: null
            }
        ]);

        const result = await buildAgentIndex({
            cwd: tempRoot,
            outputPath: '.callagent/agent-paths.json',
            allowSourceFallback: true
        });

        expect(result.warnings).toEqual([]);
        expect(result.index['source-only-agent']).toBeDefined();
        expect(result.index['source-only-agent']?.module).toBe('source-only-agent/agent.ts');
    });

    test('skips source-only .ts agent module when allowSourceFallback is disabled', async () => {
        const agentDir = path.join(tempRoot, 'source-only-agent');
        fs.mkdirSync(agentDir, { recursive: true });
        const agentModulePath = path.join(agentDir, 'agent.ts');
        const cardPath = path.join(agentDir, 'agent-card.json');

        fs.writeFileSync(agentModulePath, 'export const SourceOnlyAgent = {};', 'utf8');
        fs.writeFileSync(cardPath, JSON.stringify({ name: 'source-only-agent', version: '1.0.0' }), 'utf8');

        jest.spyOn(SmartAgentDiscoveryService, 'listAvailableAgents').mockResolvedValue([
            {
                name: 'source-only-agent',
                agentPath: agentModulePath,
                agentCardPath: cardPath,
                runtimeManifestPath: null
            }
        ]);

        const result = await buildAgentIndex({
            cwd: tempRoot,
            outputPath: '.callagent/agent-paths.json',
            allowSourceFallback: false
        });

        expect(result.index['source-only-agent']).toBeUndefined();
        expect(result.warnings).toEqual([
            'Skipping agent "source-only-agent" because runtime module was not found near source-only-agent/agent.ts'
        ]);
    });
});
