import { PrismaClient } from '../generated/prisma-client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { logger } from '@a2arium/callagent-utils';
import { getSafePgConfig } from '../pgStartupDiagnostic.js';

type PrismaClientType = InstanceType<typeof PrismaClient>;

const log = logger.createLogger({ prefix: 'OutboxPublisher' });

type OutboxRow = { id: string; tenantId: string; topic: string; key: string; payload: any; createdAt: Date };

export class OutboxPublisher {
    private prisma: PrismaClientType;
    private running = false;
    private lastId: string | null = null;
    private timeoutId: NodeJS.Timeout | null = null;
    private ownsPrisma: boolean;

    constructor(prisma?: PrismaClientType) {
        this.ownsPrisma = !prisma;
        if (prisma) {
            this.prisma = prisma;
        } else {
            const dbUrl = process.env.MEMORY_DATABASE_URL;
            if (!dbUrl) {
                log.warn('MEMORY_DATABASE_URL not found. OutboxPublisher will be disabled.');
                this.prisma = null as any;
                return;
            }
            console.log(`[OutboxPublisher] Initializing with: ${dbUrl.split('@')[1] || 'hidden'}`);
            if (typeof dbUrl !== 'string') {
                throw new Error(`Invalid type for database URL: expected string, received ${typeof dbUrl}. Check your environment variables.`);
            }
            const config = getSafePgConfig(dbUrl);
            this.prisma = new PrismaClient({
                adapter: new PrismaPg(config, { schema: 'public' }),
                log: ['info', 'warn', 'error']
            }) as any;
        }
    }

    start(intervalMs = 500): void {
        if (!this.prisma) {
            log.debug('OutboxPublisher start() ignored: no prisma client');
            return;
        }
        if (this.running) return;
        this.running = true;
        const tick = async () => {
            if (!this.running) {
                log.debug('tick() called but running=false, exiting');
                return;
            }
            try {
                await this.publishOnce();
            } catch (e) {
                log.warn('publishOnce failed', e as any);
            } finally {
                // Fix race condition: only schedule next tick if still running (Hypothesis 1)
                if (this.running) {
                    this.timeoutId = setTimeout(tick, intervalMs);
                } else {
                    log.debug('Skipping setTimeout - not running');
                }
            }
        };
        tick();
    }

    stop(): void {
        this.running = false;
        // Clear any pending timeout
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    /**
     * Check if publisher is currently running
     */
    isActive(): boolean {
        return this.running;
    }

    /**
     * Disconnect the Prisma client if this instance owns it
     * This prevents hanging database connections (Hypothesis 3)
     */
    async disconnect(): Promise<void> {
        this.stop();
        if (this.ownsPrisma) {
            try {
                await this.prisma.$disconnect();
                log.debug('Prisma client disconnected');
            } catch (error) {
                log.warn('Error disconnecting Prisma client', error as any);
            }
        }
    }

    private async publishOnce(): Promise<void> {
        if (!this.prisma) return;
        // Simple polling publisher; production should use NOTIFY/LISTEN or job queue
        const rows: OutboxRow[] = await this.prisma.outbox.findMany({
            orderBy: { createdAt: 'asc' },
            take: 50
        }) as any;
        for (const row of rows) {
            try {
                // Idempotent consumers: include id and key for de-duplication
                await this.dispatch(row);
                // Idempotent delete - ignore if record already deleted by another process
                await this.prisma.outbox.delete({ where: { id: row.id } }).catch((deleteError: any) => {
                    // Check if it's a "record not found" error (P2025 in Prisma)
                    if (deleteError.code === 'P2025' || deleteError.message?.includes('No record was found')) {
                        log.debug('Outbox record already deleted by another process', { id: row.id });
                        return; // This is expected in concurrent scenarios
                    }
                    throw deleteError; // Re-throw other errors
                });
            } catch (e) {
                log.error('Failed to dispatch outbox row', e as any, { id: row.id, topic: row.topic });
                // leave row for retry
            }
        }
    }

    private async dispatch(row: OutboxRow): Promise<void> {
        // Map topics to transports; for now, log-only with CloudEvents envelope
        const cloud = {
            specversion: '1.0',
            id: row.id,
            type: row.topic,
            source: `/tenants/${row.tenantId}/tasks/${row.key}`,
            time: row.createdAt.toISOString(),
            datacontenttype: 'application/json',
            data: row.payload
        };
        // TODO: push to SSE/webhook/Kafka; here we just log for scaffold
        log.debug('Dispatch', { topic: row.topic, key: row.key, id: row.id });
    }
}

export const outboxPublisher = new OutboxPublisher();


