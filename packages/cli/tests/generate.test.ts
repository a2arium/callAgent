import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { addAgentSource, createAgent, createAgentProject, createWorkspace, removeAgentSource } from '../src/generate.js';
import { localSourceStatus, setupLocalSource, unlinkLocalSource } from '../src/localSource.js';
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
        const envExample = fs.readFileSync(path.join(workspace, '.env.example'), 'utf8');
        expect(envExample).toContain('HATCHET_CLIENT_TOKEN=replace-with-hatchet-api-token');
        expect(envExample).toContain('BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters');
        const workspacePackage = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
        expect(workspacePackage.scripts).toMatchObject({ start: 'callagent start', dev: 'callagent start', 'db:setup': 'callagent db setup', 'infra:up': 'callagent infra up' });
        const readme = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
        expect(readme).toContain('npm run infra:up');
        expect(readme).toContain('npm run db:setup');
        expect(readme).toContain('npm run start');
        expect(readme).toContain('http://127.0.0.1:8790/operator');
        expect(readme).toContain('Settings → API Tokens');
        expect(readme).toContain('UNAUTHENTICATED: invalid auth token');
    });

    test('always uses publishable semver ranges, including inside the CallAgent repository', async () => {
        const project = path.join(process.cwd(), 'apps', 'examples', 'generator-local-range-test');
        try {
            await createAgentProject('generator-local-range-test', { output: project, force: true });
            const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
            expect(manifest.dependencies['@a2arium/callagent-core']).toBe('^0.3.0');
        } finally {
            fs.rmSync(project, { recursive: true, force: true });
        }
    });

    test('manages an owned local-source overlay without changing package.json', async () => {
        const source = createSourceCheckout(path.join(root, 'source'));
        const project = path.join(root, 'external-project');
        fs.mkdirSync(project, { recursive: true });
        const manifest = '{\n  "name": "external-project",\n  "dependencies": { "@a2arium/callagent-core": "^0.3.0" }\n}\n';
        fs.writeFileSync(path.join(project, 'package.json'), manifest);

        await setupLocalSource(project, source);
        expect(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).toBe(manifest);
        const coreLink = path.join(project, 'node_modules', '@a2arium', 'callagent-core');
        expect(fs.realpathSync(coreLink)).toBe(fs.realpathSync(path.join(source, 'packages', 'core')));
        if (process.platform !== 'win32') {
            expect(path.isAbsolute(fs.readlinkSync(coreLink))).toBe(false);
            expect(path.isAbsolute(fs.readlinkSync(path.join(project, 'node_modules', '.bin', 'callagent')))).toBe(false);
        }
        expect(await localSourceStatus(project)).toMatchObject({ mode: 'local-source', ok: true });
        await unlinkLocalSource(project);
        expect(fs.existsSync(path.join(project, 'node_modules', '@a2arium', 'callagent-core'))).toBe(false);
    });

    test('refuses to replace a package path not owned by the overlay', async () => {
        const source = createSourceCheckout(path.join(root, 'source'));
        const project = path.join(root, 'external-project');
        fs.mkdirSync(path.join(project, 'node_modules', '@a2arium', 'callagent-core'), { recursive: true });
        await expect(setupLocalSource(project, source)).rejects.toThrow('Refusing to replace unowned package path');
    });

    test('requires compiled agent modules before a source can be composed', async () => {
        const project = path.join(root, 'unbuilt-agents');
        await createAgentProject('unbuilt-agents', { output: project, withAgent: 'researcher' });
        const workspace = path.join(root, 'workspace');
        await createWorkspace('workspace', { output: workspace });
        await expect(addAgentSource(project, { workspaces: path.join(workspace, '.callagent', 'workspaces.json') })).rejects.toThrow('Build the agent project');
        expect(JSON.parse(fs.readFileSync(path.join(workspace, '.callagent', 'workspaces.json'), 'utf8'))).toEqual({ workspaces: [] });
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
        materializeCompiledAgents(project, ['researcher']);
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

function createSourceCheckout(source: string): string {
    fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'callagent', workspaces: ['packages/*'] }));
    for (const [folder, name] of [['core', '@a2arium/callagent-core'], ['runtime', '@a2arium/callagent-runtime'], ['cli', '@a2arium/callagent-cli']] as const) {
        const packageRoot = path.join(source, 'packages', folder);
        fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name }));
        fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export {};\n');
    }
    fs.writeFileSync(path.join(source, 'packages', 'cli', 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    return source;
}
