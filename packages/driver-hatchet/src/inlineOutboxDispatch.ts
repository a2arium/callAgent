import type { IEventBus } from '@a2arium/callagent-core/unstable';
import {
    claimOutboxRow,
    defaultMetricsRegistry,
    deleteClaimedOutboxRow,
    dispatchOutboxRow,
    releaseClaimedOutboxRow,
    type OutboxRow,
} from '@a2arium/callagent-core/unstable';
import { logger } from '@a2arium/callagent-utils';
import { v7 as uuidv7 } from 'uuid';

const log = logger.createLogger({ prefix: 'HatchetOutboxFallback' });

export type InlineOutboxPrisma = {
    outbox: {
        findUnique: (args: { where: { id: string } }) => Promise<OutboxRow | null>;
        delete: (args: { where: { id: string } }) => Promise<unknown>;
        updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
        deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
    };
};

/** Synchronous outbox delivery when Hatchet trigger is unavailable. */
export async function dispatchOutboxRowInline(params: {
    eventBus: IEventBus;
    prisma: InlineOutboxPrisma;
    outboxRowId: string;
}): Promise<boolean> {
    const leaseId = `inline:${uuidv7()}`;
    const claim = await claimOutboxRow({
        prisma: params.prisma as Parameters<typeof claimOutboxRow>[0]['prisma'],
        id: params.outboxRowId,
        leaseId,
        scope: 'shared',
    });
    if (claim.disposition !== 'claimed' || !claim.row) {
        log.debug('Inline outbox dispatch skipped', {
            id: params.outboxRowId,
            disposition: claim.disposition,
        });
        return false;
    }
    const row = claim.row;
    try {
        await dispatchOutboxRow({ eventBus: params.eventBus, row });
        await deleteClaimedOutboxRow({
            prisma: params.prisma as Parameters<typeof deleteClaimedOutboxRow>[0]['prisma'],
            id: row.id,
            leaseId,
        });
    } catch (error) {
        await releaseClaimedOutboxRow({
            prisma: params.prisma as Parameters<typeof releaseClaimedOutboxRow>[0]['prisma'],
            id: row.id,
            leaseId,
        }).catch(() => false);
        throw error;
    }
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
