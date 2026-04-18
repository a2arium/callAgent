import { PrismaClient } from '../generated/prisma-client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { logger } from '@a2arium/callagent-utils';
import { getSafePgConfig } from '../pgStartupDiagnostic.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { createBusEvent } from './busEventHelpers.js';
import { taskChannel } from './taskEventEmitter.js';

const log = logger.createLogger({ prefix: 'OutboxPublisher' });

type PrismaClientType = InstanceType<typeof PrismaClient>;

type OutboxRow = {
    id: string;
    tenantId: string;
    topic: string;
    key: string;
    payload: unknown;
    createdAt: Date;
    retryCount: number;
};

function outboxChannel(row: { topic: string; key: string }): string {
    if (
        row.topic === 'task.status' ||
        row.topic === 'task.input_required' ||
        row.topic === 'task.child_dispatch'
    ) {
        return taskChannel(row.key);
    }
    if (row.topic.startsWith('conversation.')) {
        return row.topic;
    }
    return row.topic;
}

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
            try {
                await this.dispatch(row);
                await this.prisma.outbox.delete({ where: { id: row.id } }).catch((deleteError: { code?: string; message?: string }) => {
                    if (deleteError.code === 'P2025' || deleteError.message?.includes('No record was found')) {
                        log.debug('Outbox record already deleted by another process', { id: row.id });
                        return;
                    }
                    throw deleteError;
                });
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log.error('Failed to dispatch outbox row', e as { message?: string }, { id: row.id, topic: row.topic });
                const nextRetry = (row.retryCount ?? 0) + 1;
                if (nextRetry >= this.maxRetries) {
                    try {
                        await this.prisma.conversationDeadLetter.create({
                            data: {
                                tenantId: row.tenantId,
                                conversationId: `outbox:${row.topic}`,
                                sequenceNumber: 0,
                                consumerId: row.id,
                                record: row.payload as object,
                                lastError: msg.length > 2000 ? `${msg.slice(0, 2000)}…` : msg,
                                attempts: nextRetry,
                                deadletteredAt: new Date(),
                            },
                        });
                    } catch (dlqErr) {
                        log.error('Dead-letter insert failed', dlqErr as { message?: string }, { id: row.id });
                    }
                    await this.prisma.outbox.delete({ where: { id: row.id } }).catch(() => undefined);
                    continue;
                }
                await this.prisma.outbox
                    .update({
                        where: { id: row.id },
                        data: { retryCount: nextRetry },
                    })
                    .catch(() => undefined);
            }
        }
    }

    private async dispatch(row: OutboxRow): Promise<void> {
        const channel = outboxChannel(row);
        await this.eventBus.publish(
            createBusEvent({
                channel,
                partitionKey: row.key,
                cloud: {
                    id: row.id,
                    type: row.topic,
                    source: `/tenants/${row.tenantId}/tasks/${row.key}`,
                    time: row.createdAt.toISOString(),
                    datacontenttype: 'application/json',
                    data: row.payload,
                },
            })
        );
    }
}
