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
        materializeCompiledAgents(project, ['researcher', 'writer']);
        const workspace = path.join(root, 'content-team');
        await createWorkspace('content-team', { output: workspace, agentSources: [project] });

        const index = JSON.parse(fs.readFileSync(path.join(project, '.callagent', 'agent-paths.json'), 'utf8')) as Record<string, unknown>;
        expect(Object.keys(index).sort()).toEqual(['researcher', 'writer']);
        const { descriptor } = await resolveWorkspaceRuntime({ cwd: workspace });
        expect(descriptor.workspaces.flatMap((entry) => entry.agents.map((agent) => agent.id))).toEqual(['researcher', 'writer']);
        const registry = fs.readFileSync(path.join(workspace, '.callagent', 'workspaces.json'), 'utf8');
        expect(registry).toContain('../content-agents');
        const projectPackage = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
        expect(projectPackage.dependencies['@a2arium/callagent-core']).toBe('^0.3.0');
    });

    test('uses workspace ranges only for projects generated inside the CallAgent repository', async () => {
        const project = path.join(process.cwd(), 'apps', 'examples', 'generator-local-range-test');
        try {
            await createAgentProject('generator-local-range-test', { output: project, force: true });
            const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
            expect(manifest.dependencies['@a2arium/callagent-core']).toBe('workspace:*');
        } finally {
            fs.rmSync(project, { recursive: true, force: true });
        }
    });

    test('requires compiled agent modules before a source can be composed', async () => {
        const project = path.join(root, 'unbuilt-agents');
        await createAgentProject('unbuilt-agents', { output: project, withAgent: 'researcher' });
        const workspace = path.join(root, 'workspace');
        await createWorkspace('workspace', { output: workspace, agentSources: [project] });
        await expect(resolveWorkspaceRuntime({ cwd: workspace })).rejects.toThrow('Build the agent project');
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

function materializeCompiledAgents(project: string, agentNames: string[]): void {
    for (const agentName of agentNames) {
        const source = path.join(project, 'src', 'agents', agentName);
        const target = path.join(project, 'dist', 'agents', agentName);
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'agent.js'), 'export {};\n');
        fs.copyFileSync(path.join(source, 'agent-card.json'), path.join(target, 'agent-card.json'));
        fs.copyFileSync(path.join(source, 'agent-runtime.json'), path.join(target, 'agent-runtime.json'));
    }
}
