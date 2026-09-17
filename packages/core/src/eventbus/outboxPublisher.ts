import { PrismaClient } from '../generated/prisma-client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '@a2arium/callagent-utils';
import { getSafePgConfig } from '../pgStartupDiagnostic.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import {
    claimOutboxRow,
    deleteClaimedOutboxRow,
    dispatchOutboxRow,
    handleOutboxDispatchFailure,
    readOutboxStorageNow,
    shouldPollerSkipOutboxRow,
    type OutboxRow,
} from './outboxDispatch.js';
import { v7 as uuidv7 } from 'uuid';
import { defaultMetricsRegistry } from '../observability/metrics.js';

const log = logger.createLogger({ prefix: 'OutboxPublisher' });

type PrismaClientType = InstanceType<typeof PrismaClient>;

export type OutboxPublisherOptions = {
    eventBus: IEventBus;
    getPrisma?: () => PrismaClientType | null | undefined;
    /** @default 10 */
    maxRetries?: number;
    /** @default 500 */
    pollIntervalMs?: number;
};

export class OutboxPublisher {
    private prisma: PrismaClientType | null;
    private running = false;
    private timeoutId: NodeJS.Timeout | null = null;
    private readonly ownsPrisma: boolean;
    private readonly eventBus: IEventBus;
    private readonly getPrisma?: () => PrismaClientType | null | undefined;
    private readonly maxRetries: number;
    private readonly pollIntervalMs: number;
    private lastProcessRowScavengeAt = 0;

    constructor(options: OutboxPublisherOptions) {
        this.eventBus = options.eventBus;
        this.getPrisma = options.getPrisma;
        this.maxRetries = options.maxRetries ?? 10;
        this.pollIntervalMs = options.pollIntervalMs ?? 500;
        if (options.getPrisma) {
            this.prisma = options.getPrisma() ?? null;
            this.ownsPrisma = false;
        } else {
            this.ownsPrisma = true;
            const dbUrl = process.env.MEMORY_DATABASE_URL;
            if (!dbUrl) {
                log.warn('MEMORY_DATABASE_URL not found. OutboxPublisher will be disabled.');
                this.prisma = null;
                return;
            }
            if (typeof dbUrl !== 'string') {
                throw new Error(
                    `Invalid type for database URL: expected string, received ${typeof dbUrl}. Check your environment variables.`
                );
            }
            const config = getSafePgConfig(dbUrl);
            this.prisma = new PrismaClient({
                adapter: new PrismaPg(config, { schema: 'public' }),
                log: ['error'],
            }) as PrismaClientType;
        }
    }

    start(intervalMs?: number): void {
        if (this.eventBus.deliveryScope !== 'shared') {
            log.debug('OutboxPublisher global scan disabled for process-local event bus');
            return;
        }
        const ms = intervalMs ?? this.pollIntervalMs;
        this.refreshPrismaFromGetter();
        if (!this.prisma) {
            log.debug('OutboxPublisher start() ignored: no prisma client');
            return;
        }
        if (this.running) {
            return;
        }
        this.running = true;
        const tick = async () => {
            if (!this.running) {
                log.debug('tick() called but running=false, exiting');
                return;
            }
            try {
                this.refreshPrismaFromGetter();
                await this.publishOnce();
            } catch (e) {
                log.warn('publishOnce failed', e as { message?: string });
            } finally {
                if (this.running) {
                    this.timeoutId = setTimeout(tick, ms);
                } else {
                    log.debug('Skipping setTimeout - not running');
                }
            }
        };
        void tick();
    }

    private refreshPrismaFromGetter(): void {
        if (this.getPrisma) {
            this.prisma = this.getPrisma() ?? null;
        }
    }

    stop(): void {
        this.running = false;
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    isActive(): boolean {
        return this.running;
    }

    async disconnect(): Promise<void> {
        this.stop();
        if (this.ownsPrisma && this.prisma) {
            try {
                await this.prisma.$disconnect();
                log.debug('Prisma client disconnected');
            } catch (error) {
                log.warn('Error disconnecting Prisma client', error as { message?: string });
            }
        }
    }

    private async publishOnce(): Promise<void> {
        if (!this.prisma) {
            return;
        }
        await this.scavengeOrphanedProcessRows();
        const storageNow = await readOutboxStorageNow(
            this.prisma as unknown as Parameters<typeof readOutboxStorageNow>[0]
        );
        const rows = (await this.prisma.outbox.findMany({
            where: {
                AND: [
                    { OR: [{ deliveryScope: 'shared' }, { deliveryScope: null }] },
                    { OR: [{ dispatchLeaseUntil: null }, { dispatchLeaseUntil: { lte: storageNow } }] },
                ],
            },
            orderBy: { createdAt: 'asc' },
            take: 50,
        })) as unknown as OutboxRow[];
        for (const row of rows) {
            if (shouldPollerSkipOutboxRow(row)) {
                continue;
            }
            const leaseId = uuidv7();
            const claim = await claimOutboxRow({
                prisma: this.prisma as unknown as Parameters<typeof claimOutboxRow>[0]['prisma'],
                id: row.id,
                leaseId,
                scope: 'shared',
            });
            if (claim.disposition !== 'claimed' || !claim.row) {
                continue;
            }
            try {
                await dispatchOutboxRow({ eventBus: this.eventBus, row: claim.row });
                await deleteClaimedOutboxRow({
                    prisma: this.prisma as unknown as Parameters<typeof deleteClaimedOutboxRow>[0]['prisma'],
                    id: row.id,
                    leaseId,
                });
            } catch (e) {
                await handleOutboxDispatchFailure({
                    prisma: this.prisma as unknown as Parameters<typeof handleOutboxDispatchFailure>[0]['prisma'],
                    row: claim.row,
                    error: e,
                    maxRetries: this.maxRetries,
                    leaseId,
                });
            }
        }
    }

    private async scavengeOrphanedProcessRows(): Promise<void> {
        if (!this.prisma || Date.now() - this.lastProcessRowScavengeAt < 60 * 60 * 1000) return;
        this.lastProcessRowScavengeAt = Date.now();
        const configured = Number(process.env.CALLAGENT_PROCESS_OUTBOX_RETENTION_MS);
        const retentionMs = Number.isFinite(configured) && configured > 0
            ? configured
            : 24 * 60 * 60 * 1000;
        const result = await this.prisma.outbox.deleteMany({
            where: {
                deliveryScope: 'process',
                createdAt: { lt: new Date(Date.now() - retentionMs) },
            },
        });
        if (result.count > 0) {
            defaultMetricsRegistry.increment('runtime.outbox_orphan_scavenged_total', {}, result.count);
            log.warn('Scavenged orphaned process-local outbox rows', { count: result.count });
        }
    }
}
