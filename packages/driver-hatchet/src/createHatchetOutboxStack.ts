import type { IEventBus } from '@a2arium/callagent-core/unstable';
import type { RuntimeDriver } from '@a2arium/callagent-core/unstable';
import type { TurnExecutor } from '@a2arium/callagent-core/unstable';
import { globalAgentRegistry } from '@a2arium/callagent-core';
import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import { createHatchetClient, type HatchetClient } from './hatchetClient.js';
import { DriverRunsRepository } from './driverRunsRepository.js';
import { HatchetRuntimeDriver } from './hatchetRuntimeDriver.js';
import type { HatchetEventPusher } from './hatchetRuntimeDriver.js';
import { createOutboxDispatchTask } from './tasks/outboxDispatch.js';
import { createSegmentTask } from './tasks/segment.js';
import { agentTaskName, createTaskTask } from './tasks/task.js';

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
    turnExecutor?: TurnExecutor;
};

export function createHatchetOutboxStack(params: CreateHatchetOutboxStackParams): HatchetOutboxStack {
    const hatchet = params.hatchet ?? createHatchetClient();
    const driverRuns = new DriverRunsRepository(params.prisma);
    const outboxDispatchTask = createOutboxDispatchTask(hatchet, {
        eventBus: params.eventBus,
        prisma: params.prisma,
        driverRuns,
    });
    const taskTask = params.turnExecutor !== undefined ? createTaskTask(hatchet) : undefined;
    const agentTaskTasks =
        params.turnExecutor !== undefined
            ? new Map(
                  globalAgentRegistry
                      .listAgents()
                      .map((agent) => [agent.name, createTaskTask(hatchet, undefined, agentTaskName(agent.name))])
              )
            : undefined;
    const runtimeDriver = new HatchetRuntimeDriver(
        params.delegate,
        outboxDispatchTask,
        driverRuns,
        { eventBus: params.eventBus, prisma: params.prisma },
        taskTask,
        agentTaskTasks,
        resolveEventPusher(hatchet)
    );
    return { runtimeDriver, hatchet, outboxDispatchTask, driverRuns };
}

export async function startOutboxWorker(params: {
    eventBus: IEventBus;
    prisma: PrismaClient;
    workerName?: string;
    hatchet?: HatchetClient;
    turnExecutor?: TurnExecutor;
}): Promise<{ worker: { start: () => Promise<void>; stop: () => Promise<void> } }> {
    const hatchet = params.hatchet ?? createHatchetClient();
    const driverRuns = new DriverRunsRepository(params.prisma);
    const outboxDispatchTask = createOutboxDispatchTask(hatchet, {
        eventBus: params.eventBus,
        prisma: params.prisma,
        driverRuns,
    });
    if (params.turnExecutor !== undefined) {
        const worker = await hatchet.worker(params.workerName ?? 'aplret-outbox-worker', {
            slots: Number(process.env.HATCHET_WORKER_SLOTS ?? 100),
            durableSlots: Number(process.env.HATCHET_WORKER_DURABLE_SLOTS ?? 100),
        });
        const agentTasks = globalAgentRegistry
            .listAgents()
            .map((agent) => createTaskTask(hatchet, { prisma: params.prisma }, agentTaskName(agent.name)));
        await worker.registerWorkflows([
            outboxDispatchTask,
            createSegmentTask(hatchet, { turnExecutor: params.turnExecutor, driverRuns }),
            createTaskTask(hatchet, { prisma: params.prisma }),
            ...agentTasks,
        ]);
        return { worker };
    } else {
        const worker = await hatchet.worker(params.workerName ?? 'aplret-outbox-worker');
        await worker.registerWorkflows([outboxDispatchTask]);
        return { worker };
    }
}

function resolveEventPusher(hatchet: HatchetClient): HatchetEventPusher | undefined {
    const candidate = hatchet as unknown as { events?: HatchetEventPusher };
    return candidate.events;
}
