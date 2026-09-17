import { startHatchetRuntimeWorkerApp } from '@a2arium/callagent-driver-hatchet';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntimeWorkspaceDescriptor } from './descriptor.js';
import { registerWorkspaceAgents } from './registerWorkspaceAgents.js';
import type { RuntimeProcessHandle } from './host.js';

export async function startRuntimeWorker(options: { descriptorPath?: string } = {}): Promise<RuntimeProcessHandle & { done: Promise<never> }> {
    const descriptor = await readRuntimeWorkspaceDescriptor(options);
    let registered: Awaited<ReturnType<typeof registerWorkspaceAgents>> | undefined;
    const app = await startHatchetRuntimeWorkerApp({
        registerAgents: async () => {
            registered = await registerWorkspaceAgents(descriptor);
        },
    });
    if (!registered) throw new Error('Hatchet worker started without registering workspace agents');
    let stopped = false;
    return {
        workspaceFingerprint: descriptor.fingerprint,
        agents: registered,
        stop: async () => {
            if (stopped) return;
            stopped = true;
            await app.shutdown();
        },
        done: app.done,
    };
}

async function main(): Promise<void> {
    const runtime = await startRuntimeWorker();
    console.log(`CALLAGENT_RUNTIME_READY ${JSON.stringify(runtime.agents)}`);
    process.once('SIGINT', () => void runtime.stop().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void runtime.stop().finally(() => process.exit(0)));
    await runtime.done.catch(async (error) => {
        console.error('HATCHET_WORKER_STREAM_UNAVAILABLE', { message: error instanceof Error ? error.message : String(error) });
        await runtime.stop();
        process.exit(1);
    });
}

const invokedAsEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntry) main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
