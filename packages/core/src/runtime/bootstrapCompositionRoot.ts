/**
 * Shared runtime composition root for API host and future Hatchet worker processes.
 *
 * Single place to wire TaskEngine + event bus + EngineLocator so agent/tool/plugin
 * registration stays the only other bootstrap concern (see worker-runtime.md).
 *
 * INTERNAL runtime types stay off the public package index (D1); this module is
 * exported publicly for composition roots only.
 */

import type { IWorkingMemorySessionStore } from '@a2arium/callagent-memory-engine';
import { createInMemoryEventBus } from '../eventbus/inMemoryEventBus.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import type { DurableSubscriptionPersistence } from '../eventbus/inProcessDurableSubscription.js';
import type { MessageLog } from '../public-types/messageLog/types.js';
import type { DurableSubscription } from '../public-types/messageLog/durableSubscription.types.js';
import { EngineLocator } from '../orchestration/EngineLocator.js';
import { TaskEngine } from '../orchestration/taskEngine.js';
import type { DurableHandlerInvoker } from '../orchestration/DurableHandlerInvoker.js';
import type { RuntimeDriver } from './runtimeDriver.js';
import type { TurnExecutor } from './turnExecutor.js';
import type { InProcessRuntimeStack } from './buildInProcessRuntimeStack.js';

/** Options forwarded to {@link TaskEngine} during bootstrap. */
export type TaskEngineOptions = {
    sessionStore?: IWorkingMemorySessionStore;
    handlerInvoker?: DurableHandlerInvoker;
    eventBus?: IEventBus;
    messageLog?: MessageLog;
    createDurableSubscription?: (ctx: {
        tenantId: string;
        persistence: DurableSubscriptionPersistence;
    }) => DurableSubscription;
    transportClose?: () => Promise<void>;
    runtimeDriver?: RuntimeDriver;
    runtimeDriverFactory?: (stack: InProcessRuntimeStack) => RuntimeDriver;
};

export type BootstrapCompositionRootParams = {
    taskEngine?: TaskEngineOptions;
    /** When true (default), registers the engine on {@link EngineLocator}. */
    registerEngineLocator?: boolean;
    /**
     * Optional agent/tool/plugin registration hook. Runs before TaskEngine is
     * constructed so manifests are available on the first segment.
     */
    registerAgents?: () => void | Promise<void>;
};

/** Public composition root — no orchestrator/driver types exposed (D1). */
export type RuntimeCompositionRoot = {
    engine: TaskEngine;
    eventBus: IEventBus;
    shutdown: () => void;
    waitForIdle: (timeoutMs?: number) => Promise<void>;
};

/**
 * Worker / driver-package composition root — includes runtime seam handles.
 * Import from `@a2arium/callagent-core/unstable` or the internal runtime barrel.
 */
export type RuntimeCompositionRootInternal = RuntimeCompositionRoot & {
    runtimeDriver: RuntimeDriver;
    turnExecutor: TurnExecutor;
};

/**
 * Bootstrap the shared runtime composition root used by API host and workers.
 * Returns the public surface; use {@link bootstrapCompositionRootInternal} when
 * the worker needs `runtimeDriver` / `turnExecutor`.
 */
export async function bootstrapCompositionRoot(
    params?: BootstrapCompositionRootParams
): Promise<RuntimeCompositionRoot> {
    return bootstrapCompositionRootInternal(params);
}

/** Full composition root including runtime seam handles (worker bootstrap). */
export async function bootstrapCompositionRootInternal(
    params?: BootstrapCompositionRootParams
): Promise<RuntimeCompositionRootInternal> {
    if (params?.registerAgents) {
        await params.registerAgents();
    }

    const eventBus = params?.taskEngine?.eventBus ?? createInMemoryEventBus();
    const engine = new TaskEngine({ ...params?.taskEngine, eventBus });

    if (params?.registerEngineLocator !== false) {
        EngineLocator.setEngine(engine);
    }

    const runtimeDriver = engine.getCompositionRuntimeDriver();
    const turnExecutor = engine.getCompositionTurnExecutor();

    return {
        engine,
        eventBus,
        runtimeDriver,
        turnExecutor,
        shutdown: () => {
            EngineLocator.setEngine(null);
        },
        waitForIdle: (timeoutMs?: number) => engine.waitForBackgroundTasks(timeoutMs),
    };
}
