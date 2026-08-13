export { readRuntimeWorkspaceDescriptor, type ReadRuntimeWorkspaceDescriptorOptions } from './descriptor.js';
export { registerWorkspaceAgents, type RegisteredWorkspaceAgents } from './registerWorkspaceAgents.js';
export { runtimeEntryPoints, type RuntimeEntryPoints } from './entryPoints.js';
export type CreateCallagentRuntimeOptions = {
    workspaceDescriptorPath: string;
    mode: 'host' | 'worker';
};

/** Public descriptor-backed runtime contract. Process entries own the long-running host/worker lifecycle. */
export async function createCallagentRuntime(options: CreateCallagentRuntimeOptions): Promise<{ workspaceFingerprint: string }> {
    const { readRuntimeWorkspaceDescriptor } = await import('./descriptor.js');
    const descriptor = await readRuntimeWorkspaceDescriptor({ descriptorPath: options.workspaceDescriptorPath });
    return { workspaceFingerprint: descriptor.fingerprint };
}
