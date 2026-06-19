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
    rootTaskId?: string | null;
    parentTaskId?: string | null;
    parentAgentId?: string | null;
    childTaskId?: string | null;
    childAgentId?: string | null;
    edgeToken?: string | null;
    edgeKind?: string | null;
    turnSeq?: number | null;
    boundaryKind?: string | null;
    turnTraceId?: string | null;
};

export type FinalizeRootRunRecord = {
    tenantId: string;
    taskId: string;
    status: string;
    agentId?: string | null;
    traceId?: string | null;
    boundaryKind?: string | null;
    turnTraceId?: string | null;
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
                rootTaskId: record.rootTaskId ?? null,
                parentTaskId: record.parentTaskId ?? null,
                parentAgentId: record.parentAgentId ?? null,
                childTaskId: record.childTaskId ?? null,
                childAgentId: record.childAgentId ?? null,
                edgeToken: record.edgeToken ?? null,
                edgeKind: record.edgeKind ?? null,
                turnSeq: record.turnSeq ?? null,
                boundaryKind: record.boundaryKind ?? null,
                turnTraceId: record.turnTraceId ?? null,
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
                rootTaskId: record.rootTaskId ?? undefined,
                parentTaskId: record.parentTaskId ?? undefined,
                parentAgentId: record.parentAgentId ?? undefined,
                childTaskId: record.childTaskId ?? undefined,
                childAgentId: record.childAgentId ?? undefined,
                edgeToken: record.edgeToken ?? undefined,
                edgeKind: record.edgeKind ?? undefined,
                turnSeq: record.turnSeq ?? undefined,
                boundaryKind: record.boundaryKind ?? undefined,
                turnTraceId: record.turnTraceId ?? undefined,
                updatedAt: new Date(),
            },
        });
    }

    async finalizeRootRun(record: FinalizeRootRunRecord): Promise<void> {
        await this.prisma.driverRun.updateMany({
            where: {
                tenantId: record.tenantId,
                operation: { in: ['agent.run', 'task.start'] },
                OR: [
                    { taskId: record.taskId },
                    { rootTaskId: record.taskId },
                ],
            },
            data: {
                status: record.status,
                agentId: record.agentId ?? undefined,
                traceId: record.traceId ?? undefined,
                boundaryKind: record.boundaryKind ?? undefined,
                turnTraceId: record.turnTraceId ?? undefined,
                updatedAt: new Date(),
            },
        });
    }
}
