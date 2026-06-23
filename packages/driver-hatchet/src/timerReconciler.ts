import { logger } from '@a2arium/callagent-utils';
import type {
    RuntimeTimerRecord,
    RuntimeTimerRepository,
} from '@a2arium/callagent-core/unstable';
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
        const timers = await this.runtimeTimers.listDue({
            now,
            take: this.options.batchSize ?? 100,
        });
        await Promise.all(timers.map((timer) => this.enqueueTimerFire(timer)));
        return timers.length;
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
        } catch (error) {
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

export function isTimerSurfaceEnabled(): boolean {
    const raw = process.env.CALLAGENT_DRIVER_SURFACES;
    if (raw === undefined || raw.trim().length === 0) {
        return false;
    }
    const surfaces = raw.split(',').map((value) => value.trim()).filter(Boolean);
    return surfaces.includes('all') || surfaces.includes('timers');
}
