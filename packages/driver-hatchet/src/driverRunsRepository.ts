import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';

export type DriverRunRecord = {
    provider?: string;
    providerRunId?: string | null;
    providerTaskRunId?: string | null;
    tenantId: string;
    agentId?: string | null;
    taskId?: string | null;
    token?: string | null;
    traceId?: string | null;
    spanId?: string | null;
    idempotencyKey?: string | null;
    operation: string;
    status: string;
    outboxRowId?: string | null;
};

export class DriverRunsRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async upsertByProviderRunId(record: DriverRunRecord & { providerRunId: string }): Promise<void> {
        await this.prisma.driverRun.upsert({
            where: { providerRunId: record.providerRunId },
            create: {
                provider: record.provider ?? 'hatchet',
                providerRunId: record.providerRunId,
                providerTaskRunId: record.providerTaskRunId ?? null,
                tenantId: record.tenantId,
                agentId: record.agentId ?? null,
                taskId: record.taskId ?? null,
                token: record.token ?? null,
                traceId: record.traceId ?? null,
                spanId: record.spanId ?? null,
                idempotencyKey: record.idempotencyKey ?? null,
                operation: record.operation,
                status: record.status,
                outboxRowId: record.outboxRowId ?? null,
            },
            update: {
                providerTaskRunId: record.providerTaskRunId ?? undefined,
                agentId: record.agentId ?? undefined,
                taskId: record.taskId ?? undefined,
                token: record.token ?? undefined,
                traceId: record.traceId ?? undefined,
                spanId: record.spanId ?? undefined,
                idempotencyKey: record.idempotencyKey ?? undefined,
                status: record.status,
                outboxRowId: record.outboxRowId ?? undefined,
                updatedAt: new Date(),
            },
        });
    }
}
