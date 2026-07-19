import {
    defaultMetricsRegistry,
    markTaskTurnDispatchEnqueued,
    type SessionManager,
} from '@a2arium/callagent-core/unstable';
import { logger } from '@a2arium/callagent-utils';
import type { HatchetEventPusher } from './hatchetRuntimeDriver.js';
import type { TaskWorkflowDeclaration } from '@hatchet-dev/typescript-sdk/v1/declaration.js';
import type { TaskTaskInput, TaskTaskOutput } from './tasks/task.js';

const log = logger.createLogger({ prefix: 'TurnRequestReconciler' });

export type TurnRequestReconcilerOptions = {
    intervalMs?: number;
    batchSize?: number;
    random?: () => number;
    rootTask?: Pick<TaskWorkflowDeclaration<TaskTaskInput, TaskTaskOutput>, 'runNoWait'>;
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
        try {
            do {
                const page = await this.sessions.listRunnableTurnRequests({
                    ...(cursor ? { cursor } : {}),
                    limit: this.options.batchSize ?? 100,
                });
                const rows = page.filter((row) => row.runtimeSurface === 'hatchet');
                for (let offset = 0; offset < rows.length; offset += 4) {
                    await Promise.all(rows.slice(offset, offset + 4).map(async (row) => {
                        const tenantTaskKey = encodeTenantTaskKey(row.tenantId, row.sessionId);
                        await this.reconstructMissingInitialRoot(row, tenantTaskKey);
                        await this.events.push(
                            `task-turn-available:${tenantTaskKey}`,
                            {
                                tenantId: row.tenantId,
                                taskId: row.sessionId,
                                generation: row.generation,
                                deliveryKey: row.deliveryKey,
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

    private async reconstructMissingInitialRoot(
        row: {
            tenantId: string;
            sessionId: string;
            agentId: string;
            generation: string;
            deliveryKey: string;
        },
        tenantTaskKey: string
    ): Promise<void> {
        if (row.generation !== '1' || this.options.rootTask === undefined) return;
        const loaded = await this.sessions.load(row.tenantId, row.sessionId);
        const snapshot = asRecord(loaded?.snapshot);
        const meta = asRecord(snapshot.meta);
        if (!Object.prototype.hasOwnProperty.call(meta, 'initialInput')) return;
        const processedKeys = Array.isArray(meta.processedKeys)
            ? meta.processedKeys.filter((value): value is string => typeof value === 'string')
            : [];
        const idempotencyKey = processedKeys.find((key) => key.endsWith(':start'))
            ?? `${row.sessionId}:start`;
        const rootRunKey = `${tenantTaskKey}:root:1`;
        await this.options.rootTask.runNoWait({
            tenantId: row.tenantId,
            taskId: row.sessionId,
            rootTaskId: row.sessionId,
            tenantTaskKey,
            rootRunKey,
            agentId: row.agentId,
            input: meta.initialInput as TaskTaskInput['input'],
            idempotencyKey,
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
