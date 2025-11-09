import { PrismaClient } from '@prisma/client';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'OutboxPublisher' });

type OutboxRow = { id: string; tenantId: string; topic: string; key: string; payload: any; createdAt: Date };

export class OutboxPublisher {
    private prisma: PrismaClient;
    private running = false;
    private lastId: string | null = null;

    constructor(prisma?: PrismaClient) {
        this.prisma = prisma || new PrismaClient();
    }

    start(intervalMs = 500): void {
        if (this.running) return;
        this.running = true;
        const tick = async () => {
            if (!this.running) return;
            try {
                await this.publishOnce();
            } catch (e) {
                log.warn('publishOnce failed', e as any);
            } finally {
                setTimeout(tick, intervalMs);
            }
        };
        tick();
    }

    stop(): void { this.running = false; }

    private async publishOnce(): Promise<void> {
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


