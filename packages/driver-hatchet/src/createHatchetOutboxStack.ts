import { RuntimeTimerRepository, SessionManager } from '@a2arium/callagent-core/unstable';
import type { IEventBus } from '@a2arium/callagent-core/unstable';
import type { RuntimeDriver } from '@a2arium/callagent-core/unstable';
import type { TurnExecutor } from '@a2arium/callagent-core/unstable';
import { globalAgentRegistry, PluginManager } from '@a2arium/callagent-core';
import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import { createHatchetClient, type HatchetClient } from './hatchetClient.js';
import { DriverRunsRepository } from './driverRunsRepository.js';
import { HatchetRuntimeDriver } from './hatchetRuntimeDriver.js';
import type { HatchetEventPusher, PayloadBudgetEventRecorder } from './hatchetRuntimeDriver.js';
import { createOutboxDispatchTask } from './tasks/outboxDispatch.js';
import { createSegmentTask } from './tasks/segment.js';
import { createTaskStateTask, createTaskTask } from './tasks/task.js';
import { createTimerFireTask, type TimerFireDeps } from './tasks/timerFire.js';
import { TimerReconciler } from './timerReconciler.js';
import { TurnRequestReconciler } from './turnRequestReconciler.js';
import { resolveSharedSegmentHatchetExecutionTimeout } from './taskTimeouts.js';
import { createScheduleDispatchTask, type ScheduleDispatchDeps } from './tasks/scheduleDispatch.js';

export type HatchetOutboxStack = {
    runtimeDriver: RuntimeDriver;
    hatchet: HatchetClient;
    outboxDispatchTask: ReturnType<typeof createOutboxDispatchTask>;
    driverRuns: DriverRunsRepository;
    timerReconciler?: TimerReconciler;
};

export type CreateHatchetOutboxStackParams = {
    delegate: RuntimeDriver;
    eventBus: IEventBus;
    prisma: PrismaClient;
    hatchet?: HatchetClient;
    turnExecutor: TurnExecutor;
    budgetEvents?: PayloadBudgetEventRecorder;
    onTaskRunTimeout?: TimerFireDeps['onTaskRunTimeout'];
};

export function createHatchetOutboxStack(params: CreateHatchetOutboxStackParams): HatchetOutboxStack {
    rejectObsoleteRuntimeConfiguration();
    assertSharedOutboxEventBus(params.eventBus);
    if (params.turnExecutor === undefined) {
        throw new Error('HATCHET_RUNTIME_MISCONFIGURED: a turn executor is required for the Hatchet runtime stack.');
    }
    const hatchet = params.hatchet ?? createHatchetClient();
    const events = resolveEventPusher(hatchet);
    if (events === undefined) {
        throw new Error('HATCHET_RUNTIME_MISCONFIGURED: Hatchet event publishing is required for durable resume routing.');
    }
    const driverRuns = new DriverRunsRepository(params.prisma);
    const runtimeTimers = new RuntimeTimerRepository(params.prisma);
    const outboxDispatchTask = createOutboxDispatchTask(hatchet, {
        eventBus: params.eventBus,
        prisma: params.prisma,
        driverRuns,
    });
    const taskTask = createTaskTask(hatchet);
    const timerFireTask = createTimerFireTask(hatchet, {
        runtimeTimers,
        driverRuns,
        events,
        onTaskRunTimeout: params.onTaskRunTimeout,
    });
    const runtimeDriver = new HatchetRuntimeDriver(
        params.delegate,
        outboxDispatchTask,
        driverRuns,
        { eventBus: params.eventBus, prisma: params.prisma },
        taskTask,
        events,
        resolveRunsCanceller(hatchet),
        runtimeTimers,
        timerFireTask,
        params.budgetEvents
    );
    const timerReconciler = new TimerReconciler(runtimeTimers, timerFireTask);
    return { runtimeDriver, hatchet, outboxDispatchTask, driverRuns, timerReconciler };
}

export async function startOutboxWorker(params: {
    eventBus: IEventBus;
    prisma: PrismaClient;
    sessionManager?: SessionManager;
    workerName?: string;
    hatchet?: HatchetClient;
    turnExecutor?: TurnExecutor;
    onTaskRunTimeout?: TimerFireDeps['onTaskRunTimeout'];
    submitTask?: ScheduleDispatchDeps['submitTask'];
}): Promise<{ worker: { start: () => Promise<void>; stop: () => Promise<void> } }> {
    rejectObsoleteRuntimeConfiguration();
    assertSharedOutboxEventBus(params.eventBus);
    const hatchet = params.hatchet ?? createHatchetClient();
    const driverRuns = new DriverRunsRepository(params.prisma);
    const runtimeTimers = new RuntimeTimerRepository(params.prisma);
    const outboxDispatchTask = createOutboxDispatchTask(hatchet, {
        eventBus: params.eventBus,
        prisma: params.prisma,
        driverRuns,
    });
    const timerFireTask = createTimerFireTask(hatchet, {
        runtimeTimers,
        driverRuns,
        events: resolveEventPusher(hatchet),
        onTaskRunTimeout: params.onTaskRunTimeout,
    });
    if (params.turnExecutor !== undefined) {
        if (params.sessionManager === undefined) {
            throw new Error('HATCHET_RUNTIME_MISCONFIGURED: a SQL-backed session manager is required for Hatchet task-state operations.');
        }
        const events = resolveEventPusher(hatchet);
        if (events === undefined) {
            throw new Error('HATCHET_RUNTIME_MISCONFIGURED: Hatchet event publishing is required for durable resume routing.');
        }
        const worker = await hatchet.worker(params.workerName ?? 'aplret-outbox-worker', {
            slots: Number(process.env.HATCHET_WORKER_SLOTS ?? 100),
            durableSlots: Number(process.env.HATCHET_WORKER_DURABLE_SLOTS ?? 100),
        });
        const registeredAgents = globalAgentRegistry.listAgents();
        const agentPlugins = registeredAgents.map((agent) => PluginManager.findAgent(agent.name));
        const sharedTask = createTaskTask(hatchet, {
            prisma: params.prisma,
            sessionManager: params.sessionManager,
            driverRuns,
            runtimeTimers,
            events,
            resolveCacheConfig: (agentId) =>
                PluginManager.findAgent(agentId ?? '')?.resolved.runtimeManifest.cache,
        });
        const scheduleDispatchTask = params.submitTask
            ? createScheduleDispatchTask(hatchet, { submitTask: params.submitTask })
            : undefined;
        await worker.registerWorkflows([
            outboxDispatchTask,
            createTaskStateTask(hatchet, {
                prisma: params.prisma,
                sessionManager: params.sessionManager,
                driverRuns,
                runtimeTimers,
                events,
                resolveCacheConfig: (agentId) =>
                    PluginManager.findAgent(agentId ?? '')?.resolved.runtimeManifest.cache,
            }),
            createSegmentTask(
                hatchet,
                { turnExecutor: params.turnExecutor, driverRuns },
                { executionTimeout: resolveSharedSegmentHatchetExecutionTimeout(agentPlugins) }
            ),
            sharedTask,
            timerFireTask,
            ...(scheduleDispatchTask ? [scheduleDispatchTask] : []),
        ]);
        new TimerReconciler(runtimeTimers, timerFireTask).start();
        if (params.sessionManager) {
            new TurnRequestReconciler(params.sessionManager, events, {
                rootTask: sharedTask,
            }).start();
        }
        return { worker };
    } else {
        const worker = await hatchet.worker(params.workerName ?? 'aplret-outbox-worker');
        await worker.registerWorkflows([outboxDispatchTask, timerFireTask]);
        return { worker };
    }
}

export function assertSharedOutboxEventBus(eventBus: IEventBus): void {
    if (eventBus.deliveryScope !== 'shared') {
        throw new Error(
            'HATCHET_RUNTIME_MISCONFIGURED: Hatchet outbox workers require an event bus with deliveryScope="shared" (for example NATS).'
        );
    }
}

export function rejectObsoleteRuntimeConfiguration(): void {
    if (process.env.CALLAGENT_HATCHET_RUNTIME_PROTOCOL_VERSION !== undefined) {
        throw new Error('CALLAGENT_HATCHET_RUNTIME_PROTOCOL_VERSION is obsolete; remove it and reset non-production Hatchet histories.');
    }
    if (process.env.CALLAGENT_DRIVER_SURFACES !== undefined) {
        throw new Error('CALLAGENT_DRIVER_SURFACES is obsolete; remove it. A configured Hatchet runtime owns start, resume, and durable timer routing as one correctness boundary.');
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
