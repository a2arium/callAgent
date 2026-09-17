export { readRuntimeWorkspaceDescriptor, type ReadRuntimeWorkspaceDescriptorOptions } from './descriptor.js';
export { registerWorkspaceAgents, type RegisteredWorkspaceAgents } from './registerWorkspaceAgents.js';
export { runtimeEntryPoints, type RuntimeEntryPoints } from './entryPoints.js';
export type { RuntimeProcessHandle } from './host.js';
export type CreateCallagentRuntimeOptions = {
    workspaceDescriptorPath: string;
    mode: 'host' | 'worker';
};

export type CallagentRuntime = {
    workspaceFingerprint: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
};

/** Creates a descriptor-backed runtime that can be started and stopped by an embedding application. */
export async function createCallagentRuntime(options: CreateCallagentRuntimeOptions): Promise<CallagentRuntime> {
    const { readRuntimeWorkspaceDescriptor } = await import('./descriptor.js');
    const descriptor = await readRuntimeWorkspaceDescriptor({ descriptorPath: options.workspaceDescriptorPath });
    let handle: import('./host.js').RuntimeProcessHandle | undefined;
    return {
        workspaceFingerprint: descriptor.fingerprint,
        start: async () => {
            if (handle) return;
            handle = options.mode === 'host'
                ? await (await import('./host.js')).startRuntimeHost({ descriptorPath: options.workspaceDescriptorPath })
                : await (await import('./worker.js')).startRuntimeWorker({ descriptorPath: options.workspaceDescriptorPath });
        },
        stop: async () => {
            await handle?.stop();
            handle = undefined;
        },
    };
}
