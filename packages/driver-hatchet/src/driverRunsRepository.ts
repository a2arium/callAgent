import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import { Prisma } from '@a2arium/callagent-memory-sql/generated';
import {
    budgetErrorPayload,
    compactPayload,
    enforcePayloadBudget,
    readDriverMetadataMaxBytes,
} from '@a2arium/callagent-core/unstable';

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
    claimId?: string | null;
    turnFence?: string | null;
    claimedGeneration?: string | null;
    turnDisposition?: string | null;
    attemptSeq?: number | null;
    rootRunKey?: string | null;
    error?: Prisma.InputJsonValue | typeof Prisma.JsonNull | null;
};

export type FinalizeRootRunRecord = {
    tenantId: string;
    taskId: string;
    status: string;
    agentId?: string | null;
    traceId?: string | null;
    boundaryKind?: string | null;
    turnTraceId?: string | null;
    error?: Prisma.InputJsonValue | typeof Prisma.JsonNull | null;
};

export type DriverRunTaskSelector = {
    tenantId: string;
    taskId: string;
};

export class DriverRunsRepository {
    constructor(private readonly prisma: PrismaClient) {}

    async latestRootRun(selector: DriverRunTaskSelector): Promise<{ providerRunId: string; status: string } | undefined> {
        const row = await this.prisma.driverRun.findFirst({
            where: {
                tenantId: selector.tenantId,
                taskId: selector.taskId,
                operation: { in: ['agent.run', 'agent.run.recovery'] },
                providerRunId: { not: null },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            select: { providerRunId: true, status: true },
        });
        return row?.providerRunId ? { providerRunId: row.providerRunId, status: row.status } : undefined;
    }

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
                claimId: record.claimId ?? null,
                turnFence: record.turnFence ?? null,
                claimedGeneration: record.claimedGeneration ?? null,
                turnDisposition: record.turnDisposition ?? null,
                attemptSeq: record.attemptSeq ?? null,
                rootRunKey: record.rootRunKey ?? null,
                error: record.error ?? Prisma.JsonNull,
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
                claimId: record.claimId ?? undefined,
                turnFence: record.turnFence ?? undefined,
                claimedGeneration: record.claimedGeneration ?? undefined,
                turnDisposition: record.turnDisposition ?? undefined,
                attemptSeq: record.attemptSeq ?? undefined,
                rootRunKey: record.rootRunKey ?? undefined,
                error: driverRunErrorUpdate(record.status, record.error),
                updatedAt: new Date(),
            },
        });
    }

    async finalizeRootRun(record: FinalizeRootRunRecord): Promise<void> {
        await this.prisma.driverRun.updateMany({
            where: {
                tenantId: record.tenantId,
                taskId: record.taskId,
                operation: { in: ['agent.run', 'agent.run.recovery', 'task.start'] },
            },
            data: {
                status: record.status,
                agentId: record.agentId ?? undefined,
                traceId: record.traceId ?? undefined,
                boundaryKind: record.boundaryKind ?? undefined,
                turnTraceId: record.turnTraceId ?? undefined,
                error: driverRunErrorUpdate(record.status, record.error),
                updatedAt: new Date(),
            },
        });
    }

    async findCancelableProviderRunIds(selector: DriverRunTaskSelector): Promise<string[]> {
        const rows = await this.prisma.driverRun.findMany({
            where: {
                tenantId: selector.tenantId,
                providerRunId: { not: null },
                status: { in: ['queued', 'running'] },
                OR: [
                    { taskId: selector.taskId },
                    { rootTaskId: selector.taskId },
                ],
            },
            select: { providerRunId: true },
        });
        return [
            ...new Set(
                rows
                    .map((row) => row.providerRunId)
                    .filter((providerRunId): providerRunId is string => typeof providerRunId === 'string')
            ),
        ];
    }

    async markProviderRunsCanceled(providerRunIds: string[]): Promise<void> {
        if (providerRunIds.length === 0) {
            return;
        }
        await this.prisma.driverRun.updateMany({
            where: {
                providerRunId: { in: providerRunIds },
                status: { in: ['queued', 'running'] },
            },
            data: {
                status: 'canceled',
                updatedAt: new Date(),
            },
        });
    }
}

function driverRunErrorUpdate(
    status: string,
    error: DriverRunRecord['error'] | FinalizeRootRunRecord['error'] | undefined
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
    if (error !== undefined) {
        return error ?? Prisma.JsonNull;
    }
    const normalized = normalizeDriverRunStatus(status);
    if (normalized === 'failed' || normalized === 'canceled' || normalized === 'cancelled') {
        return undefined;
    }
    return Prisma.JsonNull;
}

function normalizeDriverRunStatus(status: string): string {
    return status.trim().toLowerCase();
}

export function serializeDriverRunError(error: unknown): Prisma.InputJsonValue {
    const budget = enforcePayloadBudget(error, {
        code: 'LIMIT_DRIVER_METADATA_TOO_LARGE',
        limitBytes: readDriverMetadataMaxBytes(),
        summary: 'Driver run error metadata exceeded the configured budget.',
    });
    if (!budget.ok) {
        return budgetErrorPayload({
            code: budget.code,
            message: budget.summary,
            limitBytes: budget.limitBytes,
            actualBytes: budget.actualBytes,
        }) as Prisma.InputJsonObject;
    }
    if (error instanceof Error) {
        return compactError({
            name: error.name,
            message: error.message,
            stack: error.stack,
        });
    }
    if (error && typeof error === 'object' && !Array.isArray(error)) {
        const record = compactPayload(error) as Record<string, unknown>;
        return compactError({
            name: typeof record.name === 'string' ? record.name : undefined,
            message: typeof record.message === 'string' ? record.message : JSON.stringify(record).slice(0, 500),
            stack: typeof record.stack === 'string' ? record.stack : undefined,
        });
    }
    return compactError({ message: String(error) });
}

function compactError(input: {
    name?: string;
    message?: string;
    stack?: string;
}): Prisma.InputJsonObject {
    return {
        ...(input.name ? { name: truncate(input.name, 120) } : {}),
        message: truncate(input.message ?? 'Unknown error', 500),
        ...(input.stack ? { stack: truncate(input.stack, 3000) } : {}),
    };
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}...` : value;
}
