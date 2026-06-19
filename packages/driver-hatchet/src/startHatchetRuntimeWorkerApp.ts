import type {
    BootstrapCompositionRootParams,
    IEventBus,
    RuntimeCompositionRootInternal,
} from '@a2arium/callagent-core/unstable';
import { bootstrapCompositionRootInternal } from '@a2arium/callagent-core/unstable';
import type { IWorkingMemorySessionStore } from '@a2arium/callagent-memory-engine';
import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import { startOutboxWorker } from './createHatchetOutboxStack.js';

export type HatchetRuntimeWorkerApp = {
    composition: RuntimeCompositionRootInternal;
    shutdown: () => Promise<void>;
};

export type StartHatchetRuntimeWorkerAppOptions = {
    workerName?: string;
    natsUrl?: string;
    registerAgents?: BootstrapCompositionRootParams['registerAgents'];
};

type NatsStandaloneModule = {
    createNatsJetStreamEventBusStandalone: (opts: {
        servers: string[];
    }) => Promise<{ eventBus: IEventBus; close: () => Promise<void> }>;
};

type MemorySqlModule = {
    WorkingMemorySessionStore: new () => IWorkingMemorySessionStore & {
        connect: () => Promise<void>;
        close: () => Promise<void>;
        getPrismaClient: () => PrismaClient;
    };
};

async function importNatsStandalone(): Promise<NatsStandaloneModule> {
    const spec = '@a2arium/callagent-eventbus-nats';
    return import(spec) as Promise<NatsStandaloneModule>;
}

async function importMemorySql(): Promise<MemorySqlModule> {
    const spec = '@a2arium/callagent-memory-sql';
    return import(spec) as Promise<MemorySqlModule>;
}

export async function startHatchetRuntimeWorkerApp(
    options?: StartHatchetRuntimeWorkerAppOptions
): Promise<HatchetRuntimeWorkerApp> {
    if (!process.env.MEMORY_DATABASE_URL) {
        throw new Error('MEMORY_DATABASE_URL is required for hatchet runtime worker');
    }

    const { WorkingMemorySessionStore } = await importMemorySql();
    const { createNatsJetStreamEventBusStandalone } = await importNatsStandalone();

    const sessionStore = new WorkingMemorySessionStore();
    await sessionStore.connect();

    const natsUrl = options?.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';
    const { eventBus, close: closeNats } = await createNatsJetStreamEventBusStandalone({
        servers: [natsUrl],
    });

    const composition = await bootstrapCompositionRootInternal({
        registerAgents: options?.registerAgents,
        taskEngine: {
            sessionStore,
            eventBus,
            transportClose: closeNats,
        },
    });

    const { worker } = await startOutboxWorker({
        eventBus,
        prisma: sessionStore.getPrismaClient(),
        turnExecutor: composition.turnExecutor,
        workerName:
            options?.workerName ?? process.env.HATCHET_WORKER_NAME ?? 'aplret-runtime-worker',
    });

    console.log('Starting Hatchet runtime worker (composition root + aplret.outbox.dispatch)...');
    await worker.start();

    return {
        composition,
        shutdown: async () => {
            await worker.stop();
            composition.shutdown();
            await closeNats();
            await sessionStore.close();
        },
    };
}
