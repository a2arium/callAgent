import { PrismaClient } from '@prisma/client';
export declare class OutboxPublisher {
    private prisma;
    private running;
    private lastId;
    constructor(prisma?: PrismaClient);
    start(intervalMs?: number): void;
    stop(): void;
    private publishOnce;
    private dispatch;
}
export declare const outboxPublisher: OutboxPublisher;
