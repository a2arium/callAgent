import { startHatchetRuntimeWorkerApp } from '@a2arium/callagent-driver-hatchet';
import { readRuntimeWorkspaceDescriptor } from './descriptor.js';
import { registerWorkspaceAgents } from './registerWorkspaceAgents.js';

async function main(): Promise<void> {
    const descriptor = await readRuntimeWorkspaceDescriptor();
    let registered: Awaited<ReturnType<typeof registerWorkspaceAgents>> | undefined;
    const app = await startHatchetRuntimeWorkerApp({
        registerAgents: async () => {
            registered = await registerWorkspaceAgents(descriptor);
        },
    });
    if (!registered) throw new Error('Hatchet worker started without registering workspace agents');
    console.log(`CALLAGENT_RUNTIME_READY ${JSON.stringify(registered)}`);
    const shutdown = async () => app.shutdown();
    process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
