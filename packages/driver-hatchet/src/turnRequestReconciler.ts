import {
    defaultMetricsRegistry,
    markTaskTurnDispatchEnqueued,
    observeTaskSubmissionBacklog,
    sweepExpiredTaskTurnClaims,
    type SessionManager,
} from '@a2arium/callagent-core/unstable';
import { logger } from '@a2arium/callagent-utils';
import type { HatchetEventPusher } from './hatchetRuntimeDriver.js';
import type { TaskWorkflowDeclaration } from '@hatchet-dev/typescript-sdk/v1/declaration.js';
import type { TaskTaskInput, TaskTaskOutput } from './tasks/task.js';
import type { DriverRunsRepository } from './driverRunsRepository.js';

const log = logger.createLogger({ prefix: 'TurnRequestReconciler' });

export type TurnRequestReconcilerOptions = {
    intervalMs?: number;
    batchSize?: number;
    random?: () => number;
    rootTask?: Pick<TaskWorkflowDeclaration<TaskTaskInput, TaskTaskOutput>, 'runNoWait'>;
    driverRuns?: DriverRunsRepository;
    providerStatus?: (providerRunId: string) => Promise<string>;
};

export class TurnRequestReconciler {
    private handle: ReturnType<typeof setTimeout> | undefined;
    private stopped = true;

    constructor(
        private readonly sessions: SessionManager,
        private readonly events: HatchetEventPusher,
        private readonly options: TurnRequestReconcilerOptions = {}
    ) {}

    async scanOnce(): Promise<number> {
        const end = defaultMetricsRegistry.startTimer('task_turn_dispatch_reconcile_ms');
        let cursor: { updatedAt: string; tenantId: string; sessionId: string } | undefined;
        let count = 0;
        const submissionRows = [] as Awaited<ReturnType<SessionManager['listRunnableTurnRequests']>>;
        try {
            if (this.sessions.supportsExpiredTaskTurnLeaseRecovery()) {
                await sweepExpiredTaskTurnClaims({
                    session: this.sessions,
                    runtimeSurface: 'hatchet',
                    pageSize: this.options.batchSize ?? 100,
                });
            }
            do {
                const page = await this.sessions.listRunnableTurnRequests({
                    ...(cursor ? { cursor } : {}),
                    limit: this.options.batchSize ?? 100,
                });
                const rows = page.filter((row) => row.runtimeSurface === 'hatchet');
                submissionRows.push(...rows);
                for (let offset = 0; offset < rows.length; offset += 4) {
                    await Promise.all(rows.slice(offset, offset + 4).map(async (row) => {
                        const tenantTaskKey = encodeTenantTaskKey(row.tenantId, row.sessionId);
                        await this.ensureRecoveryRoot(row, tenantTaskKey);
                        await this.events.push(
                            `task-turn-available:${tenantTaskKey}`,
                            {
                                tenantId: row.tenantId,
                                taskId: row.sessionId,
                                generation: row.generation,
                                deliveryKey: row.deliveryKey,
                                ...(row.recoveryHint ? { recoveryHint: row.recoveryHint } : {}),
                            },
                            { key: row.deliveryKey }
                        );
                        await markTaskTurnDispatchEnqueued({
                            session: this.sessions,
                            tenantId: row.tenantId,
                            taskId: row.sessionId,
                            agentId: row.agentId,
                            generation: row.generation,
                            deliveryKey: row.deliveryKey,
                            runtimeSurface: 'hatchet',
                        });
                        defaultMetricsRegistry.increment('task_turn_dispatch_recovery_total', {
                            runtimeSurface: 'hatchet',
                            status: 'published',
                        });
                    }));
                }
                count += rows.length;
                const last = page.at(-1);
                cursor = last ? { updatedAt: last.updatedAt, tenantId: last.tenantId, sessionId: last.sessionId } : undefined;
                if (page.length < (this.options.batchSize ?? 100)) break;
            } while (cursor !== undefined);
            observeTaskSubmissionBacklog(submissionRows, 'hatchet');
            end({ status: 'completed' });
            return count;
        } catch (error) {
            end({ status: 'failed', errorCode: error instanceof Error ? error.name : 'Error' });
            defaultMetricsRegistry.increment('task_turn_dispatch_recovery_total', {
                runtimeSurface: 'hatchet',
                status: 'failed',
            });
            throw error;
        }
    }

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        const schedule = (delayMs: number) => {
            this.handle = setTimeout(async () => {
                try {
                    await this.scanOnce();
                    schedule(this.jitteredInterval());
                } catch (error) {
                    log.warn('Turn request reconciliation failed', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                    schedule(Math.min(60_000, Math.max(5_000, delayMs * 2)));
                }
            }, delayMs);
            this.handle.unref?.();
        };
        schedule(0);
    }

    stop(): void {
        this.stopped = true;
        if (this.handle) clearTimeout(this.handle);
        this.handle = undefined;
    }

    private jitteredInterval(): number {
        const random = this.options.random ?? Math.random;
        return Math.round((this.options.intervalMs ?? 5_000) * (0.75 + random() * 0.5));
    }

    private async ensureRecoveryRoot(
        row: {
            tenantId: string;
            sessionId: string;
            agentId: string;
            generation: string;
            deliveryKey: string;
            recoveryHint?: { reason: 'lease_expired' | 'worker_lifetime_lost' };
        },
        tenantTaskKey: string
    ): Promise<void> {
        if (this.options.rootTask === undefined) return;
        const workerRecovery = row.recoveryHint?.reason === 'worker_lifetime_lost';
        if (!workerRecovery && row.generation !== '1') return;
        if (workerRecovery && this.options.driverRuns !== undefined) {
            const latest = await this.options.driverRuns.latestRootRun({ tenantId: row.tenantId, taskId: row.sessionId });
            if (latest !== undefined) {
                const providerStatus = this.options.providerStatus
                    ? await this.options.providerStatus(latest.providerRunId).catch(() => latest.status)
                    : latest.status;
                if (!['FAILED', 'CANCELLED', 'CANCELED', 'failed', 'canceled', 'cancelled'].includes(providerStatus)) return;
            }
        }
        const loaded = await this.sessions.load(row.tenantId, row.sessionId);
        const snapshot = asRecord(loaded?.snapshot);
        const meta = asRecord(snapshot.meta);
        if (!Object.prototype.hasOwnProperty.call(meta, 'initialInput')) return;
        const rootRunKey = `${tenantTaskKey}:root:1`;
        const ref = await this.options.rootTask.runNoWait({
            tenantId: row.tenantId,
            taskId: row.sessionId,
            rootTaskId: row.sessionId,
            tenantTaskKey,
            rootRunKey,
            agentId: row.agentId,
            input: meta.initialInput as TaskTaskInput['input'],
            idempotencyKey: row.deliveryKey,
            recoveryGeneration: row.generation,
            recoveryDeliveryKey: row.deliveryKey,
        }, {
            additionalMetadata: {
                operation: 'agent.run.recovery',
                tenantId: row.tenantId,
                taskId: row.sessionId,
                rootTaskId: row.sessionId,
                tenantTaskKey,
                rootRunKey,
                deliveryKey: row.deliveryKey,
            },
        }) as { runId: Promise<string> | string };
        const providerRunId = await ref.runId;
        await this.options.driverRuns?.upsertByProviderRunId({
            providerRunId,
            tenantId: row.tenantId,
            taskId: row.sessionId,
            agentId: row.agentId,
            idempotencyKey: row.deliveryKey,
            rootTaskId: row.sessionId,
            rootRunKey,
            operation: workerRecovery ? 'agent.run.recovery' : 'agent.run',
            status: 'queued',
        });
        defaultMetricsRegistry.increment('task_turn_dispatch_recovery_total', {
            runtimeSurface: 'hatchet',
            status: 'root_reconstructed',
        });
    }
}

function encodeTenantTaskKey(tenantId: string, taskId: string): string {
    return `${tenantId.length}:${tenantId}:${taskId.length}:${taskId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
