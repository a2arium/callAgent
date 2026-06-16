import type { DispatchOutboxParams } from '@a2arium/callagent-core/unstable';

export type DriverRunMetadata = {
    tenantId?: string;
    agentId?: string;
    taskId?: string;
    token?: string;
    traceId?: string;
    spanId?: string;
    idempotencyKey?: string;
    operation: string;
};

export function buildDriverRunMetadata(
    params: DispatchOutboxParams & {
        operation?: string;
        traceId?: string;
        token?: string;
    }
): Record<string, string> {
    const tenantId = params.tenantId ?? '';
    const taskId = params.taskId ?? '';
    const traceId = params.traceId ?? '';
    const token = params.token ?? '';
    const metadata: Record<string, string> = {
        operation: params.operation ?? 'outbox.dispatch',
        eventType: params.eventType,
        outboxRowId: params.outboxRowId,
    };
    if (tenantId) {
        metadata.tenantId = tenantId;
        metadata.tenantTaskKey = `${tenantId}:${taskId}`;
        if (traceId) {
            metadata.tenantTraceKey = `${tenantId}:${traceId}`;
        }
    }
    if (taskId) {
        metadata.taskId = taskId;
    }
    if (params.agentId) {
        metadata.agentId = params.agentId;
    }
    if (traceId) {
        metadata.traceId = traceId;
    }
    if (token) {
        metadata.token = token;
        metadata.taskTokenKey = `${taskId}:${token}`;
    }
    return metadata;
}
