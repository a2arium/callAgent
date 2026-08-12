import { startHatchetRuntimeWorkerApp } from '@a2arium/callagent-driver-hatchet';
import { readRuntimeWorkspaceDescriptor } from './descriptor.js';
import { registerWorkspaceAgents } from './registerWorkspaceAgents.js';

async function main(): Promise<void> {
    const descriptor = await readRuntimeWorkspaceDescriptor();
    const app = await startHatchetRuntimeWorkerApp({
        registerAgents: async () => {
            const registered = await registerWorkspaceAgents(descriptor);
            console.log(`CALLAGENT_RUNTIME_READY ${JSON.stringify(registered)}`);
        },
    });
    const shutdown = async () => app.shutdown();
    process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
