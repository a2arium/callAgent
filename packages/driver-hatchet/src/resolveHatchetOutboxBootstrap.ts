import type { IEventBus } from '@a2arium/callagent-core/unstable';
import type { InProcessRuntimeStack, RuntimeDriver } from '@a2arium/callagent-core/unstable';
import type { IWorkingMemorySessionStore } from '@a2arium/callagent-memory-engine';
import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';
import { createHatchetOutboxStack } from './createHatchetOutboxStack.js';

export type HatchetOutboxBootstrap = {
    runtimeDriverFactory: (stack: InProcessRuntimeStack) => RuntimeDriver;
};

export function resolveHatchetOutboxBootstrap(params: {
    sessionStore?: IWorkingMemorySessionStore;
    eventBus: IEventBus;
}): HatchetOutboxBootstrap {
    if (!(params.sessionStore instanceof WorkingMemorySessionStore)) {
        throw new Error(
            'CALLAGENT_OUTBOX_DISPATCHER=hatchet requires a database-backed WorkingMemorySessionStore'
        );
    }
    const prisma = params.sessionStore.getPrismaClient() as PrismaClient;
    const { eventBus } = params;
    return {
        runtimeDriverFactory: (stack) =>
            createHatchetOutboxStack({
                delegate: stack.runtimeDriver,
                eventBus,
                prisma,
                turnExecutor: stack.turnExecutor,
            }).runtimeDriver,
    };
}
