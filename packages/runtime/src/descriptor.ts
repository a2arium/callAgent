import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceDescriptorFingerprint, type RuntimeWorkspaceDescriptor } from '@a2arium/callagent-core';

export type ReadRuntimeWorkspaceDescriptorOptions = {
    descriptorPath?: string;
    expectedFingerprint?: string;
};

/** Reads and validates the immutable descriptor that was created before child processes started. */
export async function readRuntimeWorkspaceDescriptor(
    options: ReadRuntimeWorkspaceDescriptorOptions = {}
): Promise<RuntimeWorkspaceDescriptor> {
    const descriptorPath = options.descriptorPath ?? process.env.CALLAGENT_WORKSPACE_DESCRIPTOR;
    if (!descriptorPath) {
        throw new Error('CALLAGENT_WORKSPACE_DESCRIPTOR is required when starting a descriptor-backed runtime');
    }
    const absolutePath = path.resolve(descriptorPath);
    const raw = await fs.readFile(absolutePath, 'utf8');
    const value = JSON.parse(raw) as unknown;
    const descriptor = validateDescriptor(value, absolutePath);
    const actualFingerprint = workspaceDescriptorFingerprint(withoutFingerprint(descriptor));
    if (actualFingerprint !== descriptor.fingerprint) {
        throw new Error(`Runtime workspace descriptor has an invalid fingerprint: ${absolutePath}`);
    }
    const expected = options.expectedFingerprint ?? process.env.CALLAGENT_WORKSPACE_FINGERPRINT;
    if (expected && descriptor.fingerprint !== expected) {
        throw new Error(`Workspace descriptor fingerprint mismatch: expected ${expected}, received ${descriptor.fingerprint}`);
    }
    await verifyDescriptorContents(descriptor);
    return descriptor;
}

function withoutFingerprint(descriptor: RuntimeWorkspaceDescriptor): Omit<RuntimeWorkspaceDescriptor, 'fingerprint'> {
    const { fingerprint: _fingerprint, ...without } = descriptor;
    return without;
}

function validateDescriptor(value: unknown, descriptorPath: string): RuntimeWorkspaceDescriptor {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.registryPath !== 'string' ||
        typeof value.invocationCwd !== 'string' || typeof value.fingerprint !== 'string' ||
        !Array.isArray(value.workspaces) || !isRecord(value.environment)) {
        throw new Error(`Invalid runtime workspace descriptor: ${descriptorPath}`);
    }
    if (!Array.isArray(value.environment.keys) || !Array.isArray(value.environment.conflicts)) {
        throw new Error(`Invalid runtime environment metadata: ${descriptorPath}`);
    }
    for (const workspace of value.workspaces) {
        if (!isRecord(workspace) || typeof workspace.name !== 'string' || typeof workspace.root !== 'string' ||
            typeof workspace.agentIndexPath !== 'string' || typeof workspace.envFilePath !== 'string' ||
            typeof workspace.indexDigest !== 'string' || !Array.isArray(workspace.agents)) {
            throw new Error(`Invalid runtime workspace entry: ${descriptorPath}`);
        }
        for (const agent of workspace.agents) {
            if (!isRecord(agent) || typeof agent.id !== 'string' || typeof agent.sourceName !== 'string' ||
                typeof agent.modulePath !== 'string' || !isRecord(agent.digests) || typeof agent.digests.module !== 'string') {
                throw new Error(`Invalid runtime agent entry: ${descriptorPath}`);
            }
        }
    }
    return value as RuntimeWorkspaceDescriptor;
}

async function verifyDescriptorContents(descriptor: RuntimeWorkspaceDescriptor): Promise<void> {
    for (const workspace of descriptor.workspaces) {
        await verifyDigest(workspace.agentIndexPath, workspace.indexDigest, `agent index for ${workspace.name}`);
        for (const agent of workspace.agents) {
            await verifyDigest(agent.modulePath, agent.digests.module, `module for ${agent.id}`);
            if (agent.agentCardPath && agent.digests.agentCard) {
                await verifyDigest(agent.agentCardPath, agent.digests.agentCard, `agent card for ${agent.id}`);
            }
            if (agent.runtimeManifestPath && agent.digests.runtimeManifest) {
                await verifyDigest(agent.runtimeManifestPath, agent.digests.runtimeManifest, `runtime manifest for ${agent.id}`);
            }
        }
    }
}

async function verifyDigest(filePath: string, expected: string, label: string): Promise<void> {
    const actual = createHash('sha256').update(await fs.readFile(filePath, 'utf8')).digest('hex');
    if (actual !== expected) throw new Error(`Workspace descriptor is stale: ${label} changed after resolution`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
