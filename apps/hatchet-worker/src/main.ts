import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { loadWorkspaces } from '@a2arium/callagent-core';
import { readRuntimeWorkspaceDescriptor, registerWorkspaceAgents } from '@a2arium/callagent-runtime';
import { startHatchetRuntimeWorkerApp } from '@a2arium/callagent-driver-hatchet';
import { registerPhase2LoopAgent } from '@a2arium/phase2-loop-agent';
import { registerPhase2ParentAgent } from '@a2arium/phase2-parent-agent';

if (!process.env.CALLAGENT_WORKSPACE_DESCRIPTOR) loadNearestEnv();

async function main(): Promise<void> {
    const descriptor = process.env.CALLAGENT_WORKSPACE_DESCRIPTOR
        ? await readRuntimeWorkspaceDescriptor()
        : undefined;
    const app = await startHatchetRuntimeWorkerApp({
        registerAgents: async () => {
            await registerPhase2LoopAgent();
            await registerPhase2ParentAgent();
            if (descriptor) {
                const registered = await registerWorkspaceAgents(descriptor);
                console.log(`CALLAGENT_RUNTIME_READY ${JSON.stringify(registered)}`);
            } else {
                await loadWorkspaces();
            }
        },
    });

    const shutdown = async () => {
        await app.shutdown();
    };

    process.once('SIGINT', () => {
        void shutdown().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
        void shutdown().finally(() => process.exit(0));
    });
    await app.done.catch(async (error) => {
        console.error('HATCHET_WORKER_STREAM_UNAVAILABLE', {
            message: error instanceof Error ? error.message : String(error),
        });
        await app.shutdown();
        process.exitCode = 1;
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

function loadNearestEnv(): void {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
        const candidate = join(dir, '.env');
        if (existsSync(candidate)) {
            loadDotenv({ path: candidate });
            return;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    loadDotenv();
}
