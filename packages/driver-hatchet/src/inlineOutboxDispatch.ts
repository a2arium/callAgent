import type { IEventBus } from '@a2arium/callagent-core/unstable';
import {
    defaultMetricsRegistry,
    deleteOutboxRow,
    dispatchOutboxRow,
    type OutboxRow,
} from '@a2arium/callagent-core/unstable';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'HatchetOutboxFallback' });

export type InlineOutboxPrisma = {
    outbox: {
        findUnique: (args: { where: { id: string } }) => Promise<OutboxRow | null>;
        delete: (args: { where: { id: string } }) => Promise<unknown>;
    };
};

/** Synchronous outbox delivery when Hatchet trigger is unavailable. */
export async function dispatchOutboxRowInline(params: {
    eventBus: IEventBus;
    prisma: InlineOutboxPrisma;
    outboxRowId: string;
}): Promise<boolean> {
    const row = await params.prisma.outbox.findUnique({
        where: { id: params.outboxRowId },
    });
    if (!row) {
        log.debug('Inline outbox dispatch skipped: row not found', { id: params.outboxRowId });
        return false;
    }
    await dispatchOutboxRow({ eventBus: params.eventBus, row });
    await deleteOutboxRow({ prisma: params.prisma, id: row.id });
    defaultMetricsRegistry.increment('runtime.inline_fallback_total', {
        operation: 'effect.outbox.dispatch',
        status: 'completed',
    });
    log.warn('Hatchet trigger failed; delivered outbox row inline', {
        outboxRowId: params.outboxRowId,
        topic: row.topic,
    });
    return true;
}
