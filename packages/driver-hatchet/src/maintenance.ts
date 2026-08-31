import { randomUUID } from 'node:crypto';
import { CacheCleanupService } from '@a2arium/callagent-memory-engine';
import { OperatorRetentionService, readRetentionPolicyFromEnv } from '@a2arium/callagent-core/unstable';
import type { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import type { Context } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { JsonObject } from '@hatchet-dev/typescript-sdk/v1/types.js';
import type { HatchetClient } from './hatchetClient.js';

export type MaintenanceAction = 'expire' | 'retention';

export type MaintenanceConfig = {
    installationId: string;
    owner: boolean;
    tenantId: string;
    expiryCron: string;
    retentionCron: string;
    batchSize: number;
    maxBatches: number;
    maxSeconds: number;
    leaseSeconds: number;
};

export type MaintenanceRunResult = {
    action: MaintenanceAction;
    skipped: boolean;
    reason?: 'lease-held' | 'not-owner';
    deleted: number;
    batches: number;
    dryRun: boolean;
};

export function readMaintenanceConfig(env: NodeJS.ProcessEnv = process.env): MaintenanceConfig {
    const installationId = env.CALLAGENT_MAINTENANCE_INSTALLATION_ID?.trim() || 'default';
    return {
        installationId,
        owner: env.CALLAGENT_MAINTENANCE_OWNER !== 'false',
        tenantId: env.CALLAGENT_MAINTENANCE_TENANT_ID?.trim() || env.OPERATOR_BOOTSTRAP_TENANT_ID?.trim() || 'default',
        expiryCron: env.CALLAGENT_MAINTENANCE_EXPIRY_CRON?.trim() || '17 * * * *',
        retentionCron: env.CALLAGENT_MAINTENANCE_RETENTION_CRON?.trim() || '23 3 * * *',
        batchSize: positiveInt(env.CALLAGENT_MAINTENANCE_BATCH_SIZE, 500),
        maxBatches: positiveInt(env.CALLAGENT_MAINTENANCE_MAX_BATCHES, 20),
        maxSeconds: positiveInt(env.CALLAGENT_MAINTENANCE_MAX_SECONDS, 300),
        leaseSeconds: positiveInt(env.CALLAGENT_MAINTENANCE_LEASE_SECONDS, 300),
    };
}

export class WorkspaceMaintenanceService {
    readonly config: MaintenanceConfig;
    private readonly cache: CacheCleanupService;

    constructor(private readonly prisma: PrismaClient | any, env: NodeJS.ProcessEnv = process.env) {
        this.config = readMaintenanceConfig(env);
        this.cache = new CacheCleanupService(prisma);
    }

    async status(): Promise<Record<string, unknown>> {
        const cache = await this.cache.getTenantStats(this.config.tenantId);
        const retention = await new OperatorRetentionService(this.prisma, readRetentionPolicyFromEnv()).plan({
            tenantId: this.config.tenantId,
            apply: process.env.CALLAGENT_RETENTION_APPLY === 'true',
        });
        return {
            installationId: this.config.installationId,
            owner: this.config.owner,
            tenantId: this.config.tenantId,
            schedules: { expiry: this.config.expiryCron, retention: this.config.retentionCron },
            cache: { ...cache, activeEntries: cache.totalEntries - cache.expiredEntries },
            retention,
        };
    }

    async run(action: MaintenanceAction, options: { requireOwner?: boolean } = {}): Promise<MaintenanceRunResult> {
        if (options.requireOwner === true && !this.config.owner) {
            return { action, skipped: true, reason: 'not-owner', deleted: 0, batches: 0, dryRun: action === 'retention' && process.env.CALLAGENT_RETENTION_APPLY !== 'true' };
        }
        const holderId = randomUUID();
        const key = `${this.config.installationId}:${action}`;
        if (!await this.acquireLease(key, holderId)) {
            return { action, skipped: true, reason: 'lease-held', deleted: 0, batches: 0, dryRun: action === 'retention' && process.env.CALLAGENT_RETENTION_APPLY !== 'true' };
        }
        try {
            return action === 'expire'
                ? await this.expire(key, holderId)
                : await this.retention(key, holderId);
        } finally {
            await this.prisma.maintenanceLease.deleteMany({ where: { tenantId: this.config.tenantId, key, holderId } });
        }
    }

    private async expire(key: string, holderId: string): Promise<MaintenanceRunResult> {
        let deleted = 0;
        let batches = 0;
        const deadline = Date.now() + this.config.maxSeconds * 1_000;
        for (; batches < this.config.maxBatches;) {
            if (Date.now() >= deadline) break;
            batches += 1;
            const result = await this.cache.cleanupExpired({ tenantId: this.config.tenantId, batchSize: this.config.batchSize });
            deleted += result.deleted;
            await this.refreshLease(key, holderId);
            if (!result.hasMore) break;
        }
        return { action: 'expire', skipped: false, deleted, batches: deleted === 0 ? 0 : batches, dryRun: false };
    }

    private async retention(key: string, holderId: string): Promise<MaintenanceRunResult> {
        if (process.env.CALLAGENT_RETENTION_APPLY !== 'true') {
            await new OperatorRetentionService(this.prisma, readRetentionPolicyFromEnv()).plan({ tenantId: this.config.tenantId });
            return { action: 'retention', skipped: false, deleted: 0, batches: 0, dryRun: true };
        }
        let batches = 0;
        let deleted = 0;
        const deadline = Date.now() + this.config.maxSeconds * 1_000;
        for (; batches < this.config.maxBatches;) {
            if (Date.now() >= deadline) break;
            const service = new OperatorRetentionService(this.prisma, readRetentionPolicyFromEnv());
            const plan = await service.plan({ tenantId: this.config.tenantId, apply: true });
            const eligible = plan.tables.filter((table) => !table.preserved && table.applyEnabled).reduce((sum, table) => sum + table.count, 0);
            if (eligible === 0) break;
            batches += 1;
            await service.apply({ tenantId: this.config.tenantId, actorId: `maintenance:${this.config.installationId}`, actorType: 'service', reason: 'workspace maintenance retention' });
            const after = await service.plan({ tenantId: this.config.tenantId, apply: true });
            const remaining = after.tables.filter((table) => !table.preserved && table.applyEnabled).reduce((sum, table) => sum + table.count, 0);
            deleted += Math.max(0, eligible - remaining);
            await this.refreshLease(key, holderId);
        }
        return { action: 'retention', skipped: false, deleted, batches, dryRun: false };
    }

    private async acquireLease(key: string, holderId: string): Promise<boolean> {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + this.config.leaseSeconds * 1000);
        const lease = this.prisma.maintenanceLease;
        const updated = await lease.updateMany({ where: { tenantId: this.config.tenantId, key, leaseUntil: { lte: now } }, data: { holderId, leaseUntil } });
        if (updated.count > 0) return true;
        try {
            await lease.create({ data: { tenantId: this.config.tenantId, key, holderId, leaseUntil } });
            return true;
        } catch (error: any) {
            if (error?.code !== 'P2002') throw error;
            const retry = await lease.updateMany({ where: { tenantId: this.config.tenantId, key, leaseUntil: { lte: now } }, data: { holderId, leaseUntil } });
            return retry.count > 0;
        }
    }

    private async refreshLease(key: string, holderId: string): Promise<void> {
        const result = await this.prisma.maintenanceLease.updateMany({
            where: { tenantId: this.config.tenantId, key, holderId },
            data: { leaseUntil: new Date(Date.now() + this.config.leaseSeconds * 1000) },
        });
        if (result.count !== 1) throw new Error('Maintenance lease was lost while processing');
    }
}

export const MAINTENANCE_SCHEMA_VERSION = 1 as const;
export type MaintenanceTaskInput = JsonObject & { schemaVersion: 1; action: MaintenanceAction; tenantId: string; installationId: string };

export function maintenanceWorkflowName(config: MaintenanceConfig): string {
    return `callagent.maintenance.${config.installationId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)}`;
}

export function createMaintenanceTask(hatchet: HatchetClient, service: WorkspaceMaintenanceService) {
    const name = maintenanceWorkflowName(service.config);
    return hatchet.task<MaintenanceTaskInput, JsonObject>({
        name,
        retries: 3,
        fn: async (input: MaintenanceTaskInput, _ctx: Context<MaintenanceTaskInput>) => {
            if (input.schemaVersion !== MAINTENANCE_SCHEMA_VERSION || input.tenantId !== service.config.tenantId || input.installationId !== service.config.installationId || (input.action !== 'expire' && input.action !== 'retention')) {
                throw new Error('MAINTENANCE_INPUT_INVALID');
            }
            const result = await service.run(input.action, { requireOwner: true });
            return result as JsonObject;
        },
    });
}

export async function reconcileMaintenanceCrons(hatchet: HatchetClient, task: ReturnType<typeof createMaintenanceTask>, service: WorkspaceMaintenanceService): Promise<void> {
    if (!service.config.owner) return;
    const managedBy = 'callagent-maintenance';
    const workflow = maintenanceWorkflowName(service.config);
    const rows = await hatchet.crons.list({ offset: 0, limit: 100, workflow: task, additionalMetadata: [`managedBy:${managedBy}`, `installationId:${service.config.installationId}`] } as any) as unknown as { rows?: Array<{ metadata: { id: string }; cron?: string; input?: MaintenanceTaskInput; additionalMetadata?: Record<string, string> }> };
    for (const action of ['expire', 'retention'] as const) {
        const expression = action === 'expire' ? service.config.expiryCron : service.config.retentionCron;
        const input: MaintenanceTaskInput = { schemaVersion: 1, action, tenantId: service.config.tenantId, installationId: service.config.installationId };
        const desiredName = `${workflow}.${action}`;
        const matching = (rows.rows ?? []).filter((row) => row.additionalMetadata?.action === action);
        const current = matching.find((row) => row.cron === expression && row.input?.tenantId === input.tenantId && row.input?.installationId === input.installationId);
        await Promise.all(matching.filter((row) => row !== current).map((row) => hatchet.crons.delete(row.metadata.id)));
        if (!current) await hatchet.crons.create(task, {
            name: desiredName,
            expression,
            input,
            additionalMetadata: { managedBy, installationId: service.config.installationId, action, tenantId: service.config.tenantId },
        });
    }
}

/** Read-only provider view used by `callagent maintenance status`. */
export async function maintenanceScheduleStatus(hatchet: HatchetClient, config: MaintenanceConfig): Promise<Record<string, unknown>> {
    if (!config.owner) return { state: 'not-owner' };
    try {
        const result = await hatchet.crons.list({
            offset: 0,
            limit: 100,
            workflow: maintenanceWorkflowName(config),
            additionalMetadata: [`managedBy:callagent-maintenance`, `installationId:${config.installationId}`],
        } as any) as unknown as { rows?: Array<{ cron?: string; additionalMetadata?: Record<string, string> }> };
        const rows = result.rows ?? [];
        return {
            state: 'reachable',
            expiry: rows.some((row) => row.additionalMetadata?.action === 'expire' && row.cron === config.expiryCron) ? 'reconciled' : 'missing-or-stale',
            retention: rows.some((row) => row.additionalMetadata?.action === 'retention' && row.cron === config.retentionCron) ? 'reconciled' : 'missing-or-stale',
        };
    } catch (error) {
        return { state: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
}

function positiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
