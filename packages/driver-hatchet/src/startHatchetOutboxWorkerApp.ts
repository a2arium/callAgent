import type { IEventBus } from '@a2arium/callagent-core/unstable';
import { startOutboxWorker } from './createHatchetOutboxStack.js';

export type HatchetOutboxWorkerApp = {
    shutdown: () => Promise<void>;
};

export type StartHatchetOutboxWorkerAppOptions = {
    workerName?: string;
    natsUrl?: string;
};

type NatsStandaloneModule = {
    createNatsJetStreamEventBusStandalone: (opts: {
        servers: string[];
    }) => Promise<{ eventBus: IEventBus; close: () => Promise<void> }>;
};

type MemorySqlModule = {
    WorkingMemorySessionStore: new () => {
        connect: () => Promise<void>;
        close: () => Promise<void>;
        getPrismaClient: () => import('@a2arium/callagent-memory-sql/generated').PrismaClient;
    };
};

/** Non-literal dynamic import — avoids TS pulling workspace package sources into rootDir. */
async function importNatsStandalone(): Promise<NatsStandaloneModule> {
    const spec = '@a2arium/callagent-eventbus-nats';
    return import(spec) as Promise<NatsStandaloneModule>;
}

async function importMemorySql(): Promise<MemorySqlModule> {
    const spec = '@a2arium/callagent-memory-sql';
    return import(spec) as Promise<MemorySqlModule>;
}

/**
 * Boots the Phase 1 outbox worker: host Postgres + NATS + Hatchet worker process.
 */
export async function startHatchetOutboxWorkerApp(
    options?: StartHatchetOutboxWorkerAppOptions
): Promise<HatchetOutboxWorkerApp> {
    if (!process.env.MEMORY_DATABASE_URL) {
        throw new Error('MEMORY_DATABASE_URL is required for hatchet-worker');
    }

    const { WorkingMemorySessionStore } = await importMemorySql();
    const { createNatsJetStreamEventBusStandalone } = await importNatsStandalone();

    const sessionStore = new WorkingMemorySessionStore();
    await sessionStore.connect();
    const prisma = sessionStore.getPrismaClient();

    const natsUrl = options?.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';
    const { eventBus, close: closeNats } = await createNatsJetStreamEventBusStandalone({
        servers: [natsUrl],
    });

    const { worker } = await startOutboxWorker({
        eventBus,
        prisma,
        workerName:
            options?.workerName ?? process.env.HATCHET_WORKER_NAME ?? 'aplret-outbox-worker',
    });

    console.log('Starting Hatchet outbox worker (aplret.outbox.dispatch)...');
    await worker.start();

    return {
        shutdown: async () => {
            await worker.stop();
            await closeNats();
            await sessionStore.close();
        },
    };
}
