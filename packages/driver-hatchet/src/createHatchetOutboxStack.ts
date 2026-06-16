import type { IEventBus } from '@a2arium/callagent-core/unstable';
import type { RuntimeDriver } from '@a2arium/callagent-core/unstable';
import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import { createHatchetClient, type HatchetClient } from './hatchetClient.js';
import { DriverRunsRepository } from './driverRunsRepository.js';
import { HatchetRuntimeDriver } from './hatchetRuntimeDriver.js';
import { createOutboxDispatchTask } from './tasks/outboxDispatch.js';

export type HatchetOutboxStack = {
    runtimeDriver: RuntimeDriver;
    hatchet: HatchetClient;
    outboxDispatchTask: ReturnType<typeof createOutboxDispatchTask>;
    driverRuns: DriverRunsRepository;
};

export type CreateHatchetOutboxStackParams = {
    delegate: RuntimeDriver;
    eventBus: IEventBus;
    prisma: PrismaClient;
    hatchet?: HatchetClient;
};

export function createHatchetOutboxStack(params: CreateHatchetOutboxStackParams): HatchetOutboxStack {
    const hatchet = params.hatchet ?? createHatchetClient();
    const driverRuns = new DriverRunsRepository(params.prisma);
    const outboxDispatchTask = createOutboxDispatchTask(hatchet, {
        eventBus: params.eventBus,
        prisma: params.prisma,
        driverRuns,
    });
    const runtimeDriver = new HatchetRuntimeDriver(
        params.delegate,
        outboxDispatchTask,
        driverRuns,
        { eventBus: params.eventBus, prisma: params.prisma }
    );
    return { runtimeDriver, hatchet, outboxDispatchTask, driverRuns };
}

export async function startOutboxWorker(params: {
    eventBus: IEventBus;
    prisma: PrismaClient;
    workerName?: string;
    hatchet?: HatchetClient;
}): Promise<{ worker: { start: () => Promise<void>; stop: () => Promise<void> } }> {
    const hatchet = params.hatchet ?? createHatchetClient();
    const driverRuns = new DriverRunsRepository(params.prisma);
    const outboxDispatchTask = createOutboxDispatchTask(hatchet, {
        eventBus: params.eventBus,
        prisma: params.prisma,
        driverRuns,
    });
    const worker = await hatchet.worker(params.workerName ?? 'aplret-outbox-worker');
    await worker.registerWorkflows([outboxDispatchTask]);
    return { worker };
}
