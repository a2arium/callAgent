import { defaultMetricsRegistry } from '../observability/metrics.js';
import { OperatorAuditRepository, type OperatorAuditPrisma } from './operatorAudit.js';

export type RetentionClass = 'semantic' | 'audit' | 'debug';

export type RetentionPolicy = {
    semanticDays: number;
    auditDays: number;
    debugDays: number;
    batchSize: number;
};

export type RetentionTablePlan = {
    table: string;
    retentionClass: RetentionClass;
    cutoff: Date;
    count: number;
    sampleIds: string[];
    preserved: boolean;
    applyEnabled: boolean;
    applyBlocker?: string;
};

export type RetentionPlan = {
    tenantId: string;
    dryRun: boolean;
    apply: boolean;
    policy: RetentionPolicy;
    plannedAt: string;
    tables: RetentionTablePlan[];
};

type Delegate = {
    count?: (args: Record<string, unknown>) => Promise<number>;
    findMany?: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    deleteMany?: (args: Record<string, unknown>) => Promise<{ count: number }>;
};

export type RetentionPrisma = OperatorAuditPrisma & {
    driverRun?: Delegate;
    outbox?: Delegate;
    runtimeTimer?: Delegate;
    wMEvent?: Delegate;
    operatorAuditEvent?: Delegate;
    agentRun?: Delegate;
    agentRunEdge?: Delegate;
    turnRun?: Delegate;
    runEffect?: Delegate;
};

type RetentionTarget = {
    table: string;
    delegate: keyof RetentionPrisma;
    retentionClass: RetentionClass;
    dateField: string;
    idField: 'id' | 'eventId';
    extraWhere?: Record<string, unknown>;
    preserved: boolean;
    applyGuardEnv?: string;
};

const TARGETS: RetentionTarget[] = [
    { table: 'driver_runs', delegate: 'driverRun', retentionClass: 'debug', dateField: 'updatedAt', idField: 'id', preserved: false },
    {
        table: 'runtime_timers',
        delegate: 'runtimeTimer',
        retentionClass: 'debug',
        dateField: 'updatedAt',
        idField: 'id',
        preserved: false,
        extraWhere: { status: { in: ['fired', 'canceled', 'cancelled', 'failed'] } },
    },
    {
        table: 'wm_events',
        delegate: 'wMEvent',
        retentionClass: 'debug',
        dateField: 'createdAt',
        idField: 'eventId',
        preserved: false,
        applyGuardEnv: 'CALLAGENT_RETENTION_PRUNE_WM_EVENTS',
    },
    { table: 'operator_audit_events', delegate: 'operatorAuditEvent', retentionClass: 'audit', dateField: 'createdAt', idField: 'id', preserved: true },
];

const SEMANTIC_TABLES = ['agent_runs', 'agent_run_edges', 'turn_runs', 'run_effects'];

export function readRetentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
    return {
        semanticDays: positiveInt(env.CALLAGENT_RETENTION_SEMANTIC_DAYS, 365),
        auditDays: positiveInt(env.CALLAGENT_RETENTION_AUDIT_DAYS, 365),
        debugDays: positiveInt(env.CALLAGENT_RETENTION_DEBUG_DAYS, 7),
        batchSize: positiveInt(env.CALLAGENT_RETENTION_BATCH_SIZE, 500),
    };
}

export class OperatorRetentionService {
    constructor(private readonly prisma: RetentionPrisma, private readonly policy = readRetentionPolicyFromEnv()) {}

    async plan(params: { tenantId: string; now?: Date; apply?: boolean }): Promise<RetentionPlan> {
        const now = params.now ?? new Date();
        const tables: RetentionTablePlan[] = [];
        for (const target of TARGETS) {
            const delegate = this.prisma[target.delegate] as Delegate | undefined;
            if (!delegate?.count || !delegate.findMany) continue;
            const cutoff = cutoffFor(now, this.policy, target.retentionClass);
            const where = buildWhere(params.tenantId, target, cutoff);
            const [count, samples] = await Promise.all([
                delegate.count({ where }),
                delegate.findMany({
                    where,
                    take: Math.min(this.policy.batchSize, 10),
                    orderBy: { [target.dateField]: 'asc' },
                    select: { id: true, eventId: true },
                }),
            ]);
            tables.push({
                table: target.table,
                retentionClass: target.retentionClass,
                cutoff,
                count,
                sampleIds: samples.map((row) => String(row.id ?? row.eventId ?? 'unknown')),
                preserved: target.preserved,
                applyEnabled: targetApplyEnabled(target),
                ...(targetApplyEnabled(target) ? {} : { applyBlocker: `${target.applyGuardEnv}=true is required` }),
            });
        }
        for (const table of SEMANTIC_TABLES) {
            tables.push({
                table,
                retentionClass: 'semantic',
                cutoff: cutoffFor(now, this.policy, 'semantic'),
                count: 0,
                sampleIds: [],
                preserved: true,
                applyEnabled: false,
                applyBlocker: 'semantic summaries are preserved by Phase 5D',
            });
        }
        return {
            tenantId: params.tenantId,
            dryRun: params.apply !== true,
            apply: params.apply === true,
            policy: this.policy,
            plannedAt: now.toISOString(),
            tables,
        };
    }

    async apply(params: {
        tenantId: string;
        actorId: string;
        actorType: 'user' | 'service' | 'dev-local';
        now?: Date;
        reason?: string;
    }): Promise<RetentionPlan> {
        if (process.env.CALLAGENT_RETENTION_APPLY !== 'true') {
            throw new Error('CALLAGENT_RETENTION_APPLY=true is required for retention apply mode');
        }
        const end = defaultMetricsRegistry.startTimer('operator.retention_apply_ms', {});
        try {
            const plan = await this.plan({ tenantId: params.tenantId, now: params.now, apply: true });
            const audit = new OperatorAuditRepository(this.prisma);
            await audit.record({
                tenantId: params.tenantId,
                action: 'delete',
                actorId: params.actorId,
                actorType: params.actorType,
                accepted: true,
                reason: params.reason ?? 'operator retention apply',
                resultStatus: 'requested',
                metadata: { policy: this.policy, tables: plan.tables },
            });
            const deletedByTable: Record<string, number> = {};
            for (const target of TARGETS.filter((target) => !target.preserved)) {
                if (!targetApplyEnabled(target)) continue;
                const delegate = this.prisma[target.delegate] as Delegate | undefined;
                if (!delegate?.deleteMany || !delegate.findMany) continue;
                const cutoff = cutoffFor(params.now ?? new Date(), this.policy, target.retentionClass);
                const rows = await delegate.findMany({
                    where: buildWhere(params.tenantId, target, cutoff),
                    take: this.policy.batchSize,
                    orderBy: { [target.dateField]: 'asc' },
                    select: { [target.idField]: true },
                });
                const ids = rows
                    .map((row) => row[target.idField])
                    .filter((value): value is string => typeof value === 'string' && value.length > 0);
                if (ids.length === 0) continue;
                const deleted = await delegate.deleteMany({
                    where: { [target.idField]: { in: ids } },
                });
                defaultMetricsRegistry.increment('operator.retention_deleted_total', {
                    table: target.table,
                    retentionClass: target.retentionClass,
                }, deleted.count);
                deletedByTable[target.table] = (deletedByTable[target.table] ?? 0) + deleted.count;
            }
            await audit.record({
                tenantId: params.tenantId,
                action: 'delete',
                actorId: params.actorId,
                actorType: params.actorType,
                accepted: true,
                reason: params.reason ?? 'operator retention apply',
                resultStatus: 'applied',
                metadata: { policy: this.policy, tables: plan.tables, deletedByTable },
            });
            return plan;
        } finally {
            end({});
        }
    }
}

function cutoffFor(now: Date, policy: RetentionPolicy, retentionClass: RetentionClass): Date {
    const days = retentionClass === 'semantic'
        ? policy.semanticDays
        : retentionClass === 'audit'
            ? policy.auditDays
            : policy.debugDays;
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function buildWhere(tenantId: string, target: RetentionTarget, cutoff: Date): Record<string, unknown> {
    return {
        tenantId,
        [target.dateField]: { lt: cutoff },
        ...(target.extraWhere ?? {}),
    };
}

function targetApplyEnabled(target: RetentionTarget): boolean {
    return target.applyGuardEnv === undefined || process.env[target.applyGuardEnv] === 'true';
}

function positiveInt(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
