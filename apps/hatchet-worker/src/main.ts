import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { createNatsJetStreamEventBusStandalone } from '@a2arium/callagent-eventbus-nats';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';
import { startOutboxWorker } from '@a2arium/callagent-driver-hatchet';

loadNearestEnv();

async function main(): Promise<void> {
    if (!process.env.MEMORY_DATABASE_URL) {
        throw new Error('MEMORY_DATABASE_URL is required for hatchet-worker');
    }

    const sessionStore = new WorkingMemorySessionStore();
    await sessionStore.connect();
    const prisma = sessionStore.getPrismaClient();

    const natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222';
    const { eventBus, close: closeNats } = await createNatsJetStreamEventBusStandalone({
        servers: [natsUrl],
    });

    const { worker } = await startOutboxWorker({
        eventBus,
        prisma,
        workerName: process.env.HATCHET_WORKER_NAME ?? 'aplret-outbox-worker',
    });

    const shutdown = async () => {
        await worker.stop();
        await closeNats();
        await sessionStore.close();
    };

    process.once('SIGINT', () => {
        void shutdown().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
        void shutdown().finally(() => process.exit(0));
    });

    console.log('Starting Hatchet outbox worker (aplret.outbox.dispatch)...');
    await worker.start();
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
