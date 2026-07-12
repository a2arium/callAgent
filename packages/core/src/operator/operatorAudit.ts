import type { OperatorActorType, OperatorRequestContext } from './operatorAuth.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';

export type OperatorAuditAction =
    | 'run.cancel'
    | 'agent.cancel'
    | 'payload.launch'
    | 'payload.view'
    | 'memory.delete'
    | 'memory.retag'
    | 'memory.update'
    | 'retry'
    | 'resume'
    | 'delete';

export type OperatorAuditRecordInput = {
    tenantId: string;
    action: OperatorAuditAction;
    actorId: string;
    actorType: OperatorActorType;
    rootTaskId?: string;
    taskId?: string;
    agentId?: string;
    reason?: string;
    requestedAt?: Date;
    accepted: boolean;
    resultStatus?: string;
    errorCode?: string;
    childPropagation?: 'none' | 'best_effort' | 'completed';
    metadata?: Record<string, unknown>;
};

export type OperatorAuditEventItem = Omit<OperatorAuditRecordInput, 'requestedAt'> & {
    id: string;
    requestedAt: string;
    createdAt: string;
};

type AuditDelegate = {
    create?: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    findMany?: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
};

export type OperatorAuditPrisma = {
    operatorAuditEvent?: AuditDelegate;
};

export class OperatorAuditRepository {
    constructor(private readonly prisma: OperatorAuditPrisma | undefined) {}

    isAvailable(): boolean {
        return typeof this.prisma?.operatorAuditEvent?.create === 'function';
    }

    async record(input: OperatorAuditRecordInput): Promise<void> {
        const create = this.prisma?.operatorAuditEvent?.create;
        if (!create) {
            throw new Error('Operator audit persistence is not available');
        }
        await create({
            data: {
                tenantId: input.tenantId,
                action: input.action,
                actorType: input.actorType,
                actorId: input.actorId,
                rootTaskId: input.rootTaskId,
                taskId: input.taskId,
                agentId: input.agentId,
                reason: input.reason,
                accepted: input.accepted,
                resultStatus: input.resultStatus,
                errorCode: input.errorCode,
                childPropagation: input.childPropagation,
                metadata: input.metadata,
                requestedAt: input.requestedAt ?? new Date(),
            },
        });
    }

    async listMemoryEvents(params: { tenantId: string; key: string; limit: number }): Promise<{ items: OperatorAuditEventItem[] }> {
        const findMany = this.prisma?.operatorAuditEvent?.findMany;
        if (!findMany) {
            throw new Error('Operator audit persistence is not available');
        }
        const limit = Math.max(1, Math.min(Number.isFinite(params.limit) ? params.limit : 20, 100));
        const rows = await findMany({
            where: {
                tenantId: params.tenantId,
                action: { in: ['memory.update', 'memory.retag', 'memory.delete'] },
                OR: [
                    { metadata: { path: ['key'], equals: params.key } },
                    { metadata: { path: ['nextKey'], equals: params.key } },
                ],
            },
            orderBy: [{ requestedAt: 'desc' }, { createdAt: 'desc' }],
            take: limit,
        });
        return { items: rows.map(toAuditEventItem).filter((item): item is OperatorAuditEventItem => item !== undefined) };
    }
}

export async function writeOperatorAudit(params: {
    prisma: OperatorAuditPrisma | undefined;
    context: OperatorRequestContext;
    record: Omit<OperatorAuditRecordInput, 'tenantId' | 'actorId' | 'actorType'>;
    required: boolean;
}): Promise<void> {
    const repository = new OperatorAuditRepository(params.prisma);
    try {
        await repository.record({
            tenantId: params.context.tenantId,
            actorId: params.context.actorId,
            actorType: params.context.actorType,
            ...params.record,
        });
    } catch (error) {
        if (params.required) {
            throw error;
        }
        // Dev/local mode should stay usable even if migrations were not applied yet.
        defaultMetricsRegistry.increment('operator.audit_write_failed_total', {
            required: false,
            errorCode: error instanceof Error ? error.name : 'Error',
        });
    }
}

function toAuditEventItem(row: Record<string, unknown>): OperatorAuditEventItem | undefined {
    const id = typeof row.id === 'string' ? row.id : undefined;
    const tenantId = typeof row.tenantId === 'string' ? row.tenantId : undefined;
    const action = isOperatorAuditAction(row.action) ? row.action : undefined;
    const actorType = row.actorType === 'user' || row.actorType === 'service' || row.actorType === 'dev-local' ? row.actorType : undefined;
    const actorId = typeof row.actorId === 'string' ? row.actorId : undefined;
    if (!id || !tenantId || !action || !actorType || !actorId) return undefined;
    return {
        id,
        tenantId,
        action,
        actorType,
        actorId,
        ...(typeof row.rootTaskId === 'string' ? { rootTaskId: row.rootTaskId } : {}),
        ...(typeof row.taskId === 'string' ? { taskId: row.taskId } : {}),
        ...(typeof row.agentId === 'string' ? { agentId: row.agentId } : {}),
        ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
        accepted: row.accepted === true,
        ...(typeof row.resultStatus === 'string' ? { resultStatus: row.resultStatus } : {}),
        ...(typeof row.errorCode === 'string' ? { errorCode: row.errorCode } : {}),
        ...(row.childPropagation === 'none' || row.childPropagation === 'best_effort' || row.childPropagation === 'completed' ? { childPropagation: row.childPropagation } : {}),
        ...(row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? { metadata: row.metadata as Record<string, unknown> } : {}),
        requestedAt: iso(row.requestedAt),
        createdAt: iso(row.createdAt),
    };
}

function isOperatorAuditAction(value: unknown): value is OperatorAuditAction {
    return value === 'run.cancel' ||
        value === 'agent.cancel' ||
        value === 'payload.launch' ||
        value === 'payload.view' ||
        value === 'memory.delete' ||
        value === 'memory.retag' ||
        value === 'memory.update' ||
        value === 'retry' ||
        value === 'resume' ||
        value === 'delete';
}

function iso(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return new Date().toISOString();
}
