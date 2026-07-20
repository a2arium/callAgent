import { logger } from '@a2arium/callagent-utils';
import type {
    RuntimeTimerRecord,
    RuntimeTimerRepository,
} from '@a2arium/callagent-core/unstable';
import { defaultMetricsRegistry } from '@a2arium/callagent-core/unstable';
import type { TaskWorkflowDeclaration } from '@hatchet-dev/typescript-sdk/v1/declaration.js';
import type { TimerFireTaskInput, TimerFireTaskOutput } from './tasks/timerFire.js';

const log = logger.createLogger({ prefix: 'TimerReconciler' });

export type TimerReconcilerOptions = {
    intervalMs?: number;
    batchSize?: number;
};

export class TimerReconciler {
    private handle: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly runtimeTimers: RuntimeTimerRepository,
        private readonly timerFireTask: TaskWorkflowDeclaration<TimerFireTaskInput, TimerFireTaskOutput>,
        private readonly options: TimerReconcilerOptions = {}
    ) {}

    async scanOnce(now = new Date()): Promise<number> {
        const end = defaultMetricsRegistry.startTimer('runtime.timer_reconcile_ms');
        try {
            const timers = await this.runtimeTimers.listDue({
                now,
                take: this.options.batchSize ?? 100,
            });
            defaultMetricsRegistry.setGauge('runtime.timer_due_count', timers.length);
            const maxLag = timers.reduce((current, timer) => {
                const lag = Math.max(0, now.getTime() - timer.dueAt.getTime());
                return Math.max(current, lag);
            }, 0);
            defaultMetricsRegistry.setGauge('runtime.timer_lag_ms', maxLag);
            await Promise.all(timers.map((timer) => this.enqueueTimerFire(timer)));
            end({ status: 'completed' });
            return timers.length;
        } catch (error) {
            defaultMetricsRegistry.increment('runtime.timer_reconcile_failure_total', {
                phase: 'scan',
                errorCode: error instanceof Error ? error.name : 'Error',
            });
            end({
                status: 'failed',
                errorCode: error instanceof Error ? error.name : 'Error',
            });
            throw error;
        }
    }

    start(): void {
        if (this.handle !== undefined) {
            return;
        }
        void this.scanOnce().catch((error) => {
            log.error('Initial timer reconciliation failed', formatError(error));
        });
        this.handle = setInterval(() => {
            void this.scanOnce().catch((error) => {
                log.error('Timer reconciliation failed', formatError(error));
            });
        }, this.options.intervalMs ?? 30_000);
    }

    stop(): void {
        if (this.handle === undefined) {
            return;
        }
        clearInterval(this.handle);
        this.handle = undefined;
    }

    private async enqueueTimerFire(timer: RuntimeTimerRecord): Promise<void> {
        try {
            const ref = await this.timerFireTask.runNoWait(
                {
                    tenantId: timer.tenantId,
                    taskId: timer.taskId,
                    ...(timer.agentId !== null ? { agentId: timer.agentId } : {}),
                    token: timer.token,
                    timerId: timer.timerId,
                    idempotencyKey: timer.idempotencyKey,
                },
                {
                    additionalMetadata: {
                        operation: 'timer.fire',
                        tenantId: timer.tenantId,
                        taskId: timer.taskId,
                        rootTaskId: timer.rootTaskId ?? timer.taskId,
                        tenantTaskKey: `${timer.tenantId}:${timer.taskId}`,
                        token: timer.token,
                        timerId: timer.timerId,
                        idempotencyKey: timer.idempotencyKey,
                    },
                }
            );
            await this.runtimeTimers.attachProviderRun({
                id: timer.id,
                providerRunId: await ref.runId,
            });
            defaultMetricsRegistry.increment('hatchet.enqueue_total', {
                operation: 'timer.fire',
                status: 'completed',
            });
        } catch (error) {
            defaultMetricsRegistry.increment('hatchet.enqueue_total', {
                operation: 'timer.fire',
                status: 'failed',
                errorCode: error instanceof Error ? error.name : 'Error',
            });
            log.error('Failed to enqueue timer fire', {
                tenantId: timer.tenantId,
                taskId: timer.taskId,
                token: timer.token,
                timerId: timer.timerId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
}

function formatError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
}
