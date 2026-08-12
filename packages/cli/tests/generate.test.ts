import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { createAgent, createAgentProject, createWorkspace, removeAgentSource } from '../src/generate.js';
import { resolveWorkspaceRuntime } from '@a2arium/callagent-core';

describe('CallAgent project and workspace generation', () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'callagent-generate-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('creates a multi-agent project and a portable workspace composition', async () => {
        const project = path.join(root, 'content-agents');
        await createAgentProject('content-agents', { output: project, withAgent: 'researcher' });
        await createAgent('writer', { project });
        const workspace = path.join(root, 'content-team');
        await createWorkspace('content-team', { output: workspace, agentSources: [project] });

        const index = JSON.parse(fs.readFileSync(path.join(project, '.callagent', 'agent-paths.json'), 'utf8')) as Record<string, unknown>;
        expect(Object.keys(index).sort()).toEqual(['researcher', 'writer']);
        const { descriptor } = await resolveWorkspaceRuntime({ cwd: workspace });
        expect(descriptor.workspaces.flatMap((entry) => entry.agents.map((agent) => agent.id))).toEqual(['researcher', 'writer']);
        const registry = fs.readFileSync(path.join(workspace, '.callagent', 'workspaces.json'), 'utf8');
        expect(registry).toContain('../content-agents');
    });

    test('rejects adding an agent to a legacy flat project', async () => {
        const legacy = path.join(root, 'legacy');
        fs.mkdirSync(path.join(legacy, '.callagent'), { recursive: true });
        fs.writeFileSync(path.join(legacy, '.callagent', 'agent-paths.json'), '{}');
        fs.writeFileSync(path.join(legacy, 'agent.ts'), 'export {};');
        await expect(createAgent('second-agent', { project: legacy })).rejects.toThrow('legacy flat layout');
    });

    test('removes a selected source atomically', async () => {
        const project = path.join(root, 'project');
        await createAgentProject('project', { output: project, withAgent: 'researcher' });
        const workspace = path.join(root, 'workspace');
        await createWorkspace('workspace', { output: workspace, agentSources: [project] });
        await removeAgentSource('project', { workspaces: path.join(workspace, '.callagent', 'workspaces.json') });
        expect(JSON.parse(fs.readFileSync(path.join(workspace, '.callagent', 'workspaces.json'), 'utf8'))).toEqual({ workspaces: [] });
    });
});
