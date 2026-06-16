import type {
    CancelParams,
    DispatchOutboxParams,
    EnqueueChildDispatchParams,
    EnqueueResumeParams,
    EnqueueStartParams,
    IEventBus,
    RuntimeDriver,
    ScheduleTimerParams,
} from '@a2arium/callagent-core/unstable';
import type { TaskWorkflowDeclaration } from '@hatchet-dev/typescript-sdk';
import { logger } from '@a2arium/callagent-utils';
import { DriverRunsRepository } from './driverRunsRepository.js';
import { dispatchOutboxRowInline, type InlineOutboxPrisma } from './inlineOutboxDispatch.js';
import { buildDriverRunMetadata } from './metadata.js';
import type { OutboxDispatchInput, OutboxDispatchOutput } from './tasks/outboxDispatch.js';

const log = logger.createLogger({ prefix: 'HatchetRuntimeDriver' });

export type HatchetOutboxInlineFallback = {
    eventBus: IEventBus;
    prisma: InlineOutboxPrisma;
};

export class HatchetRuntimeDriver implements RuntimeDriver {
    constructor(
        private readonly delegate: RuntimeDriver,
        private readonly outboxDispatchTask: TaskWorkflowDeclaration<
            OutboxDispatchInput,
            OutboxDispatchOutput
        >,
        private readonly driverRuns?: DriverRunsRepository,
        private readonly inlineFallback?: HatchetOutboxInlineFallback
    ) {}

    async enqueueStart(params: EnqueueStartParams): Promise<void> {
        return this.delegate.enqueueStart(params);
    }

    async enqueueResume(params: EnqueueResumeParams): Promise<void> {
        return this.delegate.enqueueResume(params);
    }

    async enqueueChildDispatch(params: EnqueueChildDispatchParams): Promise<void> {
        return this.delegate.enqueueChildDispatch(params);
    }

    async scheduleTimer(params: ScheduleTimerParams): Promise<{ timerId: string }> {
        return this.delegate.scheduleTimer(params);
    }

    async cancel(params: CancelParams): Promise<void> {
        return this.delegate.cancel(params);
    }

    async dispatchOutbox(params: DispatchOutboxParams): Promise<void> {
        const input: OutboxDispatchInput = {
            outboxRowId: params.outboxRowId,
            eventType: params.eventType,
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            traceId: params.traceId,
            token: params.token,
        };

        try {
            const ref = await this.outboxDispatchTask.runNoWait(input, {
                additionalMetadata: buildDriverRunMetadata(params),
            });
            const providerRunId = await ref.runId;
            if (this.driverRuns && params.tenantId) {
                await this.driverRuns.upsertByProviderRunId({
                    providerRunId,
                    tenantId: params.tenantId,
                    taskId: params.taskId ?? null,
                    agentId: params.agentId ?? null,
                    traceId: params.traceId ?? null,
                    token: params.token ?? null,
                    operation: 'outbox.dispatch',
                    status: 'queued',
                    outboxRowId: params.outboxRowId,
                });
            }
        } catch (error) {
            log.error('Hatchet outbox trigger failed', error as { message?: string }, {
                outboxRowId: params.outboxRowId,
                eventType: params.eventType,
            });
            if (this.inlineFallback) {
                await dispatchOutboxRowInline({
                    eventBus: this.inlineFallback.eventBus,
                    prisma: this.inlineFallback.prisma,
                    outboxRowId: params.outboxRowId,
                });
                return;
            }
            throw error;
        }
    }

    /** Underlying in-process driver (segment scheduling). */
    getDelegate(): RuntimeDriver {
        return this.delegate;
    }
}
