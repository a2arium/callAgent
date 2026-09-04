import type {
    BootstrapCompositionRootParams,
    IEventBus,
    RuntimeCompositionRootInternal,
} from '@a2arium/callagent-core/unstable';
import { bootstrapCompositionRootInternal, SessionManager } from '@a2arium/callagent-core/unstable';
import type { IWorkingMemorySessionStore } from '@a2arium/callagent-memory-engine';
import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import {
    createHatchetOutboxStack,
    startOutboxWorker,
    type StartedHatchetWorker,
} from './createHatchetOutboxStack.js';
import { reconcileMaintenanceCrons } from './maintenance.js';
import { startWorkerHealthMonitor, type WorkerHealthMonitor } from './workerHealth.js';
import { ProviderTerminalReconciler } from './providerTerminalReconciler.js';
import { randomUUID } from 'node:crypto';

export type HatchetRuntimeWorkerApp = {
    composition: RuntimeCompositionRootInternal;
    /** Rejects when Hatchet's long-lived worker loop ends unexpectedly. */
    done: Promise<never>;
    health: () => { state: 'ready' | 'failed' | 'stopped'; lastError?: string };
    shutdown: () => Promise<void>;
};

export type StartHatchetRuntimeWorkerAppOptions = {
    workerName?: string;
    natsUrl?: string;
    registerAgents?: BootstrapCompositionRootParams['registerAgents'];
};

/** Starts Hatchet's long-lived loop and waits only for its startup handshake. */
export async function startHatchetWorkerUntilReady(
    worker: StartedHatchetWorker,
    timeoutMs = 30_000
): Promise<{ workerRun: Promise<void> }> {
    const workerRun = worker.start();
    // Keep an unexpected background failure from becoming an unhandled
    // rejection; shutdown still awaits the original promise and propagates it.
    void workerRun.catch(() => undefined);
    await worker.waitUntilReady(timeoutMs);
    return { workerRun };
}

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
    const budgetEvents = new SessionManager(sessionStore);

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
            runtimeDriverFactory: (stack) =>
                createHatchetOutboxStack({
                    delegate: stack.runtimeDriver,
                    eventBus,
                    prisma: sessionStore.getPrismaClient(),
                    turnExecutor: stack.turnExecutor,
                    budgetEvents,
                    onTaskRunTimeout: stack.onTaskRunTimeout,
                }).runtimeDriver,
        },
    });

    const workerName = `${options?.workerName ?? process.env.HATCHET_WORKER_NAME ?? 'aplret-runtime-worker'}-${randomUUID().slice(0, 8)}`;
    const started = await startOutboxWorker({
        eventBus,
        prisma: sessionStore.getPrismaClient(),
        sessionManager: budgetEvents,
        turnExecutor: composition.turnExecutor,
        onTaskRunTimeout: (params) => composition.engine.handleTaskRunTimeout(params),
        submitTask: (params) => composition.engine.submitTask(params),
        workerName,
    });

    console.log('Starting Hatchet runtime worker (composition root + aplret.outbox.dispatch)...');
    // Hatchet's start promise deliberately remains pending for the worker's
    // whole lifetime. Awaiting it here delays CallAgent readiness until the
    // worker is already stopping. Start it in the background, then wait for
    // Hatchet's explicit readiness handshake instead.
    let workerRun: Promise<void>;
    let healthMonitor: WorkerHealthMonitor | undefined;
    let terminalTimer: ReturnType<typeof setInterval> | undefined;
    let state: 'ready' | 'failed' | 'stopped' = 'ready';
    let lastError: string | undefined;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<never>((_resolve, reject) => { rejectDone = reject; });
    // The caller owns this promise and installs the process-level failure
    // policy. Keep a handler here solely to avoid an unhandled rejection.
    void done.catch(() => undefined);
    function failWorker(error: unknown): void {
        if (state !== 'ready') return;
        state = 'failed';
        lastError = error instanceof Error ? error.message : String(error);
        console.error('HATCHET_WORKER_STREAM_UNAVAILABLE', { message: lastError });
        if (terminalTimer) clearInterval(terminalTimer);
        void healthMonitor?.stop();
        // Do not keep a damaged worker accepting new work while its process
        // supervisor prepares a replacement instance.
        void started.worker.stop().catch(() => undefined);
        rejectDone(error instanceof Error ? error : new Error(lastError));
    }
    try {
        ({ workerRun } = await startHatchetWorkerUntilReady(started.worker));
        healthMonitor = await startWorkerHealthMonitor({
            prisma: sessionStore.getPrismaClient(), hatchet: started.hatchet,
            workerName,
            onStreamUnavailable: failWorker,
        });
        if (lastError !== undefined) throw new Error(lastError);
        const terminalReconciler = new ProviderTerminalReconciler(
            sessionStore.getPrismaClient(), new SessionManager(sessionStore), started.hatchet,
        );
        const reconcileProviderTerminals = () => terminalReconciler.scanOnce().catch((error) => {
            console.error('HATCHET_PROVIDER_TERMINAL_RECONCILE_FAILED', {
                message: error instanceof Error ? error.message : String(error),
            });
        });
        void reconcileProviderTerminals();
        terminalTimer = setInterval(() => void reconcileProviderTerminals(), 15_000);
        terminalTimer.unref?.();
        void workerRun.then(
            () => failWorker(new Error('HATCHET_WORKER_LOOP_ENDED')),
            (error) => failWorker(error),
        );
        if (started.maintenance) await reconcileMaintenanceCrons(started.hatchet, started.maintenance.task, started.maintenance.service);
    } catch (error) {
        await started.worker.stop().catch(() => undefined);
        composition.shutdown();
        await closeNats();
        await sessionStore.close();
        throw error;
    }

    return {
        composition,
        done,
        health: () => ({ state, ...(lastError ? { lastError } : {}) }),
        shutdown: async () => {
            try {
                if (state === 'ready') state = 'stopped';
                if (terminalTimer) clearInterval(terminalTimer);
                await healthMonitor?.stop();
                await started.worker.stop();
                await workerRun.catch(() => undefined);
            } finally {
                composition.shutdown();
                await closeNats();
                await sessionStore.close();
            }
        },
    };
}
