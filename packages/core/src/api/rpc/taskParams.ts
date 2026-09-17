import { randomUUID } from 'node:crypto';

export type RpcTaskParams = Record<string, unknown> & {
    id: string;
    agentId?: unknown;
    tenantId?: unknown;
};

export function normalizeRpcTaskParams(rawParams: unknown): RpcTaskParams | null {
    if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
        return null;
    }

    const params = { ...(rawParams as Record<string, unknown>) };
    const explicitId = typeof params.id === 'string' ? params.id.trim() : '';
    params.id = explicitId || createTaskId(params.agentId);

    return params as RpcTaskParams;
}

function createTaskId(agentId: unknown): string {
    const rawPrefix = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'task';
    const prefix = rawPrefix
        .replace(/[^a-zA-Z0-9._:-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'task';

    return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}
