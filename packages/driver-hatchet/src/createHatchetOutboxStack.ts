import type { IEventBus } from '@a2arium/callagent-core/unstable';
import type { RuntimeDriver } from '@a2arium/callagent-core/unstable';
import type { TurnExecutor } from '@a2arium/callagent-core/unstable';
import { globalAgentRegistry, PluginManager } from '@a2arium/callagent-core';
import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import { createHatchetClient, type HatchetClient } from './hatchetClient.js';
import { DriverRunsRepository } from './driverRunsRepository.js';
import { HatchetRuntimeDriver } from './hatchetRuntimeDriver.js';
import type { HatchetEventPusher } from './hatchetRuntimeDriver.js';
import { createOutboxDispatchTask } from './tasks/outboxDispatch.js';
import { createSegmentTask } from './tasks/segment.js';
import { agentTaskName, createTaskTask } from './tasks/task.js';
import {
    resolveAgentHatchetExecutionTimeout,
    resolveSharedSegmentHatchetExecutionTimeout,
} from './taskTimeouts.js';

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
    const registeredAgents = globalAgentRegistry.listAgents();
    const agentTaskTasks =
        params.turnExecutor !== undefined
            ? new Map(
                  registeredAgents.map((agent) => [
                      agent.name,
                      createTaskTask(
                          hatchet,
                          undefined,
                          agentTaskName(agent.name),
                          {
                              executionTimeout: resolveAgentHatchetExecutionTimeout(
                                  PluginManager.findAgent(agent.name)
                              ),
                          }
                      ),
                  ])
              )
            : undefined;
    const runtimeDriver = new HatchetRuntimeDriver(
        params.delegate,
        outboxDispatchTask,
        driverRuns,
        { eventBus: params.eventBus, prisma: params.prisma },
        taskTask,
        agentTaskTasks,
        resolveEventPusher(hatchet),
        resolveRunsCanceller(hatchet)
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
        const registeredAgents = globalAgentRegistry.listAgents();
        const agentTasks = registeredAgents
            .map((agent) => createTaskTask(
                hatchet,
                { prisma: params.prisma, driverRuns, events: resolveEventPusher(hatchet) },
                agentTaskName(agent.name),
                {
                    executionTimeout: resolveAgentHatchetExecutionTimeout(
                        PluginManager.findAgent(agent.name)
                    ),
                }
            ));
        const agentPlugins = registeredAgents.map((agent) => PluginManager.findAgent(agent.name));
        await worker.registerWorkflows([
            outboxDispatchTask,
            createSegmentTask(
                hatchet,
                { turnExecutor: params.turnExecutor, driverRuns },
                { executionTimeout: resolveSharedSegmentHatchetExecutionTimeout(agentPlugins) }
            ),
            createTaskTask(hatchet, { prisma: params.prisma, driverRuns, events: resolveEventPusher(hatchet) }),
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

function resolveRunsCanceller(hatchet: HatchetClient) {
    const candidate = hatchet as unknown as {
        runs?: { cancel?: (opts: { ids: string[] }) => Promise<unknown> };
    };
    return typeof candidate.runs?.cancel === 'function'
        ? { cancel: (opts: { ids: string[] }) => candidate.runs!.cancel!(opts) }
        : undefined;
}
