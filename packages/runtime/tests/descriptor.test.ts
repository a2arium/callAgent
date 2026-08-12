import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { resolveWorkspaceRuntime } from '@a2arium/callagent-core';
import { readRuntimeWorkspaceDescriptor } from '../src/descriptor.js';

describe('runtime descriptor reader', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'callagent-runtime-descriptor-'));
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('rejects a descriptor if indexed content changes after resolution', async () => {
        const workspace = path.join(root, 'workspace');
        const source = path.join(root, 'source');
        fs.mkdirSync(path.join(workspace, '.callagent'), { recursive: true });
        fs.mkdirSync(path.join(source, '.callagent'), { recursive: true });
        fs.writeFileSync(path.join(source, 'agent.js'), 'export {};');
        fs.writeFileSync(path.join(source, '.callagent', 'agent-paths.json'), JSON.stringify({ agent: { module: '../agent.js' } }));
        fs.writeFileSync(path.join(workspace, '.callagent', 'workspaces.json'), JSON.stringify({
            workspaces: [{ name: 'source', root: '../../source' }],
        }));
        const { descriptor } = await resolveWorkspaceRuntime({ cwd: workspace });
        const descriptorPath = path.join(root, 'descriptor.json');
        fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));

        await expect(readRuntimeWorkspaceDescriptor({ descriptorPath, expectedFingerprint: descriptor.fingerprint }))
            .resolves.toMatchObject({ fingerprint: descriptor.fingerprint });

        fs.appendFileSync(path.join(source, 'agent.js'), '\n// changed');
        await expect(readRuntimeWorkspaceDescriptor({ descriptorPath })).rejects.toThrow('stale');
    });
});
