import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { resolveWorkspaceRuntime, WorkspaceResolutionError } from '../src/plugin/WorkspaceResolution.js';

describe('workspace runtime resolution', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'callagent-workspace-resolution-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('produces a deterministic descriptor and one first-wins environment snapshot', async () => {
        const workspaceRoot = path.join(root, 'workspace');
        const alphaRoot = path.join(root, 'alpha');
        const betaRoot = path.join(root, 'beta');
        writeSource(alphaRoot, 'alpha-agent', { SHARED: 'alpha', ALPHA_ONLY: 'yes' });
        writeSource(betaRoot, 'beta-agent', { SHARED: 'beta', BETA_ONLY: 'yes' });
        fs.mkdirSync(path.join(workspaceRoot, '.callagent'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.env'), 'SHARED=workspace\nWORKSPACE_ONLY=yes\nSECRET=workspace-secret\n');
        fs.writeFileSync(path.join(workspaceRoot, '.callagent', 'workspaces.json'), JSON.stringify({
            workspaces: [
                { name: 'alpha', root: '../../alpha' },
                { name: 'beta', root: '../../beta' },
            ],
        }));

        const { descriptor, environment } = await resolveWorkspaceRuntime({
            cwd: workspaceRoot,
            inheritedEnv: { SHARED: 'process', PROCESS_ONLY: 'yes' },
        });

        expect(descriptor.workspaces.flatMap((workspace) => workspace.agents.map((agent) => agent.id))).toEqual(['alpha-agent', 'beta-agent']);
        expect(descriptor.environment.conflicts).toEqual([
            { key: 'SHARED', keptSource: 'process', ignoredSource: 'workspace' },
            { key: 'SHARED', keptSource: 'process', ignoredSource: 'agent-source:alpha' },
            { key: 'SHARED', keptSource: 'process', ignoredSource: 'agent-source:beta' },
        ]);
        expect(environment.values).toMatchObject({
            SHARED: 'process', PROCESS_ONLY: 'yes', WORKSPACE_ONLY: 'yes', ALPHA_ONLY: 'yes', BETA_ONLY: 'yes', SECRET: 'workspace-secret',
        });
        expect(JSON.stringify(descriptor)).not.toContain('workspace-secret');
        expect(descriptor.fingerprint).toHaveLength(64);
    });

    test('rejects stale or ambiguous composition inputs before modules are imported', async () => {
        const workspaceRoot = path.join(root, 'workspace');
        const firstRoot = path.join(root, 'first');
        const secondRoot = path.join(root, 'second');
        writeSource(firstRoot, 'same-agent');
        writeSource(secondRoot, 'same-agent');
        fs.mkdirSync(path.join(workspaceRoot, '.callagent'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.callagent', 'workspaces.json'), JSON.stringify({
            workspaces: [
                { name: 'first', root: '../../first' },
                { name: 'second', root: '../../second' },
            ],
        }));

        await expect(resolveWorkspaceRuntime({ cwd: workspaceRoot })).rejects.toMatchObject({
            name: WorkspaceResolutionError.name,
            issues: [expect.objectContaining({ message: expect.stringContaining('same-agent') })],
        });
    });

    test('allows an empty workspace only when a creation flow explicitly requests it', async () => {
        const workspaceRoot = path.join(root, 'workspace');
        fs.mkdirSync(path.join(workspaceRoot, '.callagent'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.callagent', 'workspaces.json'), JSON.stringify({ workspaces: [] }));

        await expect(resolveWorkspaceRuntime({ cwd: workspaceRoot })).rejects.toThrow('no agent sources');
        await expect(resolveWorkspaceRuntime({ cwd: workspaceRoot, allowEmpty: true })).resolves.toMatchObject({
            descriptor: { workspaces: [] },
        });
    });
});

function writeSource(root: string, agentId: string, env: Record<string, string> = {}): void {
    const agentRoot = path.join(root, 'src', 'agents', agentId);
    fs.mkdirSync(path.join(root, '.callagent'), { recursive: true });
    fs.mkdirSync(agentRoot, { recursive: true });
    fs.writeFileSync(path.join(agentRoot, 'agent.js'), 'export {};\n');
    fs.writeFileSync(path.join(agentRoot, 'agent-card.json'), JSON.stringify({
        name: agentId,
        version: '1.0.0',
        description: 'Test agent',
        supportedInterfaces: [{ url: 'https://example.test/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
        capabilities: {},
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [{ id: 'test', name: 'Test', description: 'Test skill' }],
    }));
    fs.writeFileSync(path.join(agentRoot, 'agent-runtime.json'), JSON.stringify({ name: agentId, version: '1.0.0' }));
    fs.writeFileSync(path.join(root, '.callagent', 'agent-paths.json'), JSON.stringify({
        [agentId]: {
            module: `../src/agents/${agentId}/agent.js`,
            agentCard: `../src/agents/${agentId}/agent-card.json`,
            runtimeManifest: `../src/agents/${agentId}/agent-runtime.json`,
        },
    }));
    if (Object.keys(env).length > 0) {
        fs.writeFileSync(path.join(root, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
    }
}
