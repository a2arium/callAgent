export type OperatorActorType = 'user' | 'service' | 'dev-local';

export type OperatorRequestLike = {
    method?: string;
    path?: string;
    query?: Record<string, unknown>;
    body?: unknown;
    header?: (name: string) => string | undefined;
    operatorContext?: OperatorRequestContext;
};

export type OperatorRequestContext = {
    tenantId: string;
    actorId: string;
    actorType: OperatorActorType;
    production: boolean;
    email?: string;
    role?: 'viewer' | 'operator' | 'admin';
    sessionId?: string;
    sessionCreatedAt?: Date;
    installationOwner?: boolean;
    mustChangePassword?: boolean;
};

export class OperatorAuthError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string
    ) {
        super(message);
        this.name = 'OperatorAuthError';
    }
}

export function resolveOperatorRequestContext(req: OperatorRequestLike): OperatorRequestContext {
    if (req.operatorContext) return req.operatorContext;
    const production = isProductionMode();
    if (production) {
        throw new OperatorAuthError('Named-user authentication is required', 401, 'AUTH_REQUIRED');
    }
    const actor = { actorId: 'dev-local', actorType: 'dev-local' as const };
    const tenantId = resolveTenantId(req, production);
    assertAllowedTenant(tenantId);

    return {
        tenantId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        production,
    };
}

export function isProductionMode(): boolean {
    return readEnv('CALLAGENT_MODE') === 'production' || readEnv('NODE_ENV') === 'production';
}

export function isPublicRpcEnabled(): boolean {
    return readEnv('CALLAGENT_RPC_PUBLIC') === 'true';
}

function resolveTenantId(req: OperatorRequestLike, production: boolean): string {
    const headerTenant = normalizeTenant(req.header?.('x-tenant-id'));
    const queryTenant = normalizeTenant(queryValue(req.query?.tenantId));
    const bodyTenant = normalizeTenant(bodyTenantId(req.body));
    const values = [headerTenant, queryTenant, bodyTenant].filter((value): value is string => value !== undefined);
    const configuredTenant = readEnv('CALLAGENT_OPERATOR_TENANT_ID');
    const first = configuredTenant ?? values[0] ?? 'default';
    for (const value of values.slice(1)) {
        if (value !== first) {
            throw new OperatorAuthError('Conflicting tenant identifiers were provided', 400, 'TENANT_CONFLICT');
        }
    }
    if (configuredTenant !== undefined) {
        for (const value of values) {
            if (value !== configuredTenant) {
                throw new OperatorAuthError('Tenant does not match the configured operator tenant', 403, 'TENANT_NOT_ALLOWED');
            }
        }
        return configuredTenant;
    }
    if (production && values.length === 0 && readEnv('CALLAGENT_OPERATOR_ALLOWED_TENANTS') === undefined) {
        throw new OperatorAuthError('Production operator tenant must be configured or provided from an allowed tenant', 503, 'OPERATOR_TENANT_NOT_CONFIGURED');
    }
    return first;
}

function normalizeTenant(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function queryValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
}

function bodyTenantId(body: unknown): string | undefined {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const record = body as Record<string, unknown>;
    if (typeof record.tenantId === 'string') return record.tenantId;
    const params = record.params;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
        const tenantId = (params as Record<string, unknown>).tenantId;
        if (typeof tenantId === 'string') return tenantId;
    }
    return undefined;
}

function assertAllowedTenant(tenantId: string): void {
    const raw = readEnv('CALLAGENT_OPERATOR_ALLOWED_TENANTS');
    if (!raw) return;
    const allowed = raw.split(',').map((value) => value.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(tenantId)) {
        throw new OperatorAuthError('Tenant is not allowed for this operator surface', 403, 'TENANT_NOT_ALLOWED');
    }
}

function readEnv(name: string): string | undefined {
    const value = process.env[name];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
