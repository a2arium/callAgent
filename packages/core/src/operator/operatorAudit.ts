import type { OperatorActorType, OperatorRequestContext } from './operatorAuth.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';

export type OperatorAuditAction =
    | 'run.cancel'
    | 'agent.cancel'
    | 'payload.launch'
    | 'payload.view'
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

type AuditDelegate = {
    create?: (args: { data: Record<string, unknown> }) => Promise<unknown>;
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
