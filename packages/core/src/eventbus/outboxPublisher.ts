import { PrismaClient } from '../generated/prisma-client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '@a2arium/callagent-utils';
import { getSafePgConfig } from '../pgStartupDiagnostic.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import {
    deleteOutboxRow,
    dispatchOutboxRow,
    handleOutboxDispatchFailure,
    shouldPollerSkipOutboxRow,
    type OutboxRow,
} from './outboxDispatch.js';

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
        const rows = (await this.prisma.outbox.findMany({
            orderBy: { createdAt: 'asc' },
            take: 50,
        })) as unknown as OutboxRow[];
        for (const row of rows) {
            if (shouldPollerSkipOutboxRow(row)) {
                continue;
            }
            try {
                await dispatchOutboxRow({ eventBus: this.eventBus, row });
                await deleteOutboxRow({ prisma: this.prisma, id: row.id });
            } catch (e) {
                await handleOutboxDispatchFailure({
                    prisma: this.prisma,
                    row,
                    error: e,
                    maxRetries: this.maxRetries,
                });
            }
        }
    }
}
