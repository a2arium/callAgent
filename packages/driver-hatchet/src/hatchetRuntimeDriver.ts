import type {
    CancelParams,
    DispatchOutboxParams,
    EnqueueChildDispatchParams,
    EnqueueResumeParams,
    EnqueueStartParams,
    IEventBus,
    PayloadBudgetCode,
    RuntimeDriver,
    RuntimeTimerRepository,
    ScheduleTimerParams,
} from '@a2arium/callagent-core/unstable';
import {
    compactPayload,
    enforcePayloadBudget,
    readHatchetPayloadMaxBytes,
} from '@a2arium/callagent-core/unstable';
import type { TaskWorkflowDeclaration } from '@hatchet-dev/typescript-sdk/v1/declaration.js';
import { logger } from '@a2arium/callagent-utils';
import { DriverRunsRepository } from './driverRunsRepository.js';
import { dispatchOutboxRowInline, type InlineOutboxPrisma } from './inlineOutboxDispatch.js';
import { buildDriverRunMetadata } from './metadata.js';
import type { OutboxDispatchInput, OutboxDispatchOutput } from './tasks/outboxDispatch.js';
import type { TaskTaskInput, TaskTaskOutput } from './tasks/task.js';
import type { TimerFireTaskInput, TimerFireTaskOutput } from './tasks/timerFire.js';

const log = logger.createLogger({ prefix: 'HatchetRuntimeDriver' });

export type HatchetOutboxInlineFallback = {
    eventBus: IEventBus;
    prisma: InlineOutboxPrisma;
};

export type HatchetEventPusher = {
    push: (eventKey: string, payload: Record<string, unknown>, opts?: { key?: string }) => Promise<unknown>;
};

export type HatchetRunsCanceller = {
    cancel: (opts: { ids: string[] }) => Promise<unknown>;
};

export type PayloadBudgetEventRecorder = {
    appendBudgetExceededEvent: (params: {
        tenantId: string;
        sessionId: string;
        taskId?: string;
        code: PayloadBudgetCode;
        message?: string;
        limitBytes: number;
        actualBytes?: number;
        fieldPath?: string;
        eventType?: string;
    }) => Promise<unknown>;
};

export class HatchetRuntimeDriver implements RuntimeDriver {
    constructor(
        private readonly delegate: RuntimeDriver,
        private readonly outboxDispatchTask: TaskWorkflowDeclaration<
            OutboxDispatchInput,
            OutboxDispatchOutput
        >,
        private readonly driverRuns?: DriverRunsRepository,
        private readonly inlineFallback?: HatchetOutboxInlineFallback,
        private readonly taskTask?: TaskWorkflowDeclaration<TaskTaskInput, TaskTaskOutput>,
        private readonly agentTaskTasks?: Map<
            string,
            TaskWorkflowDeclaration<TaskTaskInput, TaskTaskOutput>
        >,
        private readonly events?: HatchetEventPusher,
        private readonly runs?: HatchetRunsCanceller,
        private readonly runtimeTimers?: RuntimeTimerRepository,
        private readonly timerFireTask?: TaskWorkflowDeclaration<TimerFireTaskInput, TimerFireTaskOutput>,
        private readonly budgetEvents?: PayloadBudgetEventRecorder
    ) {}

    async enqueueStart(params: EnqueueStartParams): Promise<void> {
        const taskTask = this.resolveTaskTask(params.agentId);
        if (!this.isSurfaceEnabled('start') || taskTask === undefined) {
            return this.delegate.enqueueStart(params);
        }

        const input: TaskTaskInput = {
            tenantId: params.tenantId,
            taskId: params.taskId,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            input: params.input as TaskTaskInput['input'],
            idempotencyKey: params.idempotencyKey,
        };
        const budget = enforcePayloadBudget(input, {
            code: 'LIMIT_HATCHET_PAYLOAD_TOO_LARGE',
            limitBytes: readHatchetPayloadMaxBytes(),
            summary: 'Hatchet task payload exceeded the configured budget.',
        });
        if (!budget.ok) {
            await this.recordPayloadBudget(params.tenantId, params.taskId, budget, 'agent.run');
            throw new Error(`LIMIT_HATCHET_PAYLOAD_TOO_LARGE: ${budget.summary}`);
        }
        const ref = await taskTask.runNoWait(input, {
            additionalMetadata: buildTaskMetadata(params, 'agent.run'),
        });
        const providerRunId = await ref.runId;
        if (this.driverRuns) {
            await this.driverRuns.upsertByProviderRunId({
                providerRunId,
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId ?? null,
                traceId: params.traceId ?? null,
                token: params.token ?? null,
                idempotencyKey: params.idempotencyKey,
                rootTaskId: params.taskId,
                operation: 'agent.run',
                status: 'queued',
            });
        }
    }

    async enqueueResume(params: EnqueueResumeParams): Promise<void> {
        if (
            !this.isSurfaceEnabled('resume') ||
            this.events === undefined ||
            !isHatchetResumeEvent(params.event.kind)
        ) {
            return this.delegate.enqueueResume(params);
        }

        const payload = {
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            idempotencyKey: params.idempotencyKey,
            ...params.event,
        };
        const budget = enforcePayloadBudget(payload, {
            code: 'LIMIT_HATCHET_PAYLOAD_TOO_LARGE',
            limitBytes: readHatchetPayloadMaxBytes(),
            summary: 'Hatchet resume payload exceeded the configured budget.',
        });
        if (!budget.ok) {
            await this.recordPayloadBudget(params.tenantId, params.taskId, budget, `resume.${params.event.kind}`);
        }
        await this.events.push(
            `aplret.${params.event.kind}.${params.event.token}`,
            (budget.ok ? payload : compactPayload(budget.value)) as Record<string, unknown>,
            { key: `${params.tenantId}:${params.taskId}:${params.event.token}` }
        );
    }

    async enqueueChildDispatch(params: EnqueueChildDispatchParams): Promise<void> {
        return this.delegate.enqueueChildDispatch(params);
    }

    async scheduleTimer(params: ScheduleTimerParams): Promise<{ timerId: string }> {
        if (!this.isSurfaceEnabled('timers') || this.runtimeTimers === undefined) {
            return this.delegate.scheduleTimer(params);
        }
        const timer = await this.runtimeTimers.schedule({
            ...params,
            rootTaskId: params.taskId,
        });
        if (this.driverRuns) {
            await this.driverRuns.upsertByProviderRunId({
                providerRunId: timer.id,
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId ?? null,
                traceId: params.traceId ?? null,
                token: params.token,
                idempotencyKey: timer.idempotencyKey,
                rootTaskId: params.taskId,
                operation: 'timer.schedule',
                status: 'completed',
                boundaryKind: params.kind === 'sleep' ? 'sleep' : 'timer',
            });
        }
        if (Date.parse(params.fireAt) <= Date.now() && this.timerFireTask !== undefined) {
            const ref = await this.timerFireTask.runNoWait(
                {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                    token: params.token,
                    timerId: timer.timerId,
                    idempotencyKey: timer.idempotencyKey,
                },
                {
                    additionalMetadata: {
                        operation: 'timer.fire',
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        rootTaskId: params.taskId,
                        tenantTaskKey: `${params.tenantId}:${params.taskId}`,
                        token: params.token,
                        timerId: timer.timerId,
                        idempotencyKey: timer.idempotencyKey,
                    },
                }
            );
            await this.runtimeTimers.attachProviderRun({
                id: timer.id,
                providerRunId: await ref.runId,
            });
        }
        return { timerId: timer.timerId };
    }

    async cancel(params: CancelParams): Promise<void> {
        await this.delegate.cancel(params);
        if (this.runtimeTimers !== undefined) {
            await this.runtimeTimers.cancelTaskTimers({
                tenantId: params.tenantId,
                taskId: params.taskId,
            });
        }
        if (this.driverRuns === undefined || this.runs === undefined) {
            return;
        }

        const providerRunIds = await this.driverRuns.findCancelableProviderRunIds({
            tenantId: params.tenantId,
            taskId: params.taskId,
        });
        if (providerRunIds.length === 0) {
            return;
        }

        try {
            await this.runs.cancel({ ids: providerRunIds });
            await this.driverRuns.markProviderRunsCanceled(providerRunIds);
        } catch (error) {
            log.warn('Hatchet run cancellation failed; snapshot cancellation remains authoritative', {
                tenantId: params.tenantId,
                taskId: params.taskId,
                providerRunIds,
                error: error instanceof Error ? error.message : String(error),
            });
        }
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
                    rootTaskId: params.taskId ?? null,
                    operation: 'effect.outbox.dispatch',
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

    private isSurfaceEnabled(surface: 'start' | 'resume' | 'timers'): boolean {
        const raw = process.env.CALLAGENT_DRIVER_SURFACES;
        if (raw === undefined || raw.trim().length === 0) {
            return false;
        }
        const surfaces = raw.split(',').map((value) => value.trim()).filter(Boolean);
        return surfaces.includes('all') || surfaces.includes(surface);
    }

    private resolveTaskTask(
        agentId: string | undefined
    ): TaskWorkflowDeclaration<TaskTaskInput, TaskTaskOutput> | undefined {
        if (agentId !== undefined) {
            const agentTask = this.agentTaskTasks?.get(agentId);
            if (agentTask !== undefined) {
                return agentTask;
            }
        }
        return this.taskTask;
    }

    private async recordPayloadBudget(
        tenantId: string,
        taskId: string,
        budget: {
            code: PayloadBudgetCode;
            summary: string;
            limitBytes: number;
            actualBytes: number;
            fieldPath?: string;
        },
        eventType: string
    ): Promise<void> {
        if (!this.budgetEvents) {
            return;
        }
        try {
            await this.budgetEvents.appendBudgetExceededEvent({
                tenantId,
                sessionId: taskId,
                taskId,
                code: budget.code,
                message: budget.summary,
                limitBytes: budget.limitBytes,
                actualBytes: budget.actualBytes,
                fieldPath: budget.fieldPath,
                eventType,
            });
        } catch (error) {
            log.warn('Failed to persist payload budget event', {
                tenantId,
                taskId,
                code: budget.code,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

function isHatchetResumeEvent(kind: EnqueueResumeParams['event']['kind']): boolean {
    return kind === 'input' || kind === 'tool' || kind === 'child' || kind === 'external' || kind === 'timer';
}

function buildTaskMetadata(
    params: EnqueueStartParams,
    operation: string
): Record<string, string> {
    const metadata: Record<string, string> = {
        operation,
        tenantId: params.tenantId,
        taskId: params.taskId,
        rootTaskId: params.taskId,
        tenantTaskKey: `${params.tenantId}:${params.taskId}`,
        idempotencyKey: params.idempotencyKey,
    };
    if (params.agentId !== undefined) {
        metadata.agentId = params.agentId;
    }
    if (params.traceId !== undefined) {
        metadata.traceId = params.traceId;
    }
    if (params.token !== undefined) {
        metadata.token = params.token;
    }
    return metadata;
}
