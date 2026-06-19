import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { startHatchetRuntimeWorkerApp } from '@a2arium/callagent-driver-hatchet';
import { registerPhase2LoopAgent } from '@a2arium/phase2-loop-agent';
import { registerPhase2ParentAgent } from '@a2arium/phase2-parent-agent';

loadNearestEnv();

async function main(): Promise<void> {
    const app = await startHatchetRuntimeWorkerApp({
        registerAgents: async () => {
            await registerPhase2LoopAgent();
            await registerPhase2ParentAgent();
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
