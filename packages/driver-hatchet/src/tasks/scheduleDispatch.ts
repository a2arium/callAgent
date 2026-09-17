import { createHash } from 'node:crypto';
import { TaskSubmissionError, type SubmitTaskResult, type TaskSubmissionOrigin } from '@a2arium/callagent-core';
import type { Context } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { JsonObject, JsonValue } from '@hatchet-dev/typescript-sdk/v1/types.js';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1/task.js';
import type { HatchetClient } from '../hatchetClient.js';

export const SCHEDULE_DISPATCH_TASK_NAME = 'aplret.schedule.dispatch';
export const SCHEDULE_SCHEMA_VERSION = 1 as const;

export type ScheduleDispatchInput = JsonObject & {
    schemaVersion: 1;
    scheduleId: string;
    revision: number;
    kind: 'once' | 'cron';
    tenantId: string;
    agentId: string;
    displayName: string;
    input: JsonValue;
    options?: { maxTurns?: number };
    scheduledFor?: string;
};

export type ScheduleDispatchOutput = JsonObject & {
    taskId: string;
    status: SubmitTaskResult['status'];
    occurrenceId: string;
};

export type ScheduleDispatchDeps = {
    submitTask: (input: {
        tenantId: string;
        taskId: string;
        agentId: string;
        input: unknown;
        options?: { maxTurns?: number };
        origin: TaskSubmissionOrigin;
    }) => Promise<SubmitTaskResult>;
    resolveScheduledFor?: (occurrenceId: string, taskRunExternalId?: string) => Promise<string | undefined>;
};

export function scheduleMetadata(input: ScheduleDispatchInput): Record<string, string> {
    return {
        managedBy: 'callagent',
        scheduleSchemaVersion: String(SCHEDULE_SCHEMA_VERSION),
        callagentScheduleId: input.scheduleId,
        revision: String(input.revision),
        tenantId: input.tenantId,
        agentId: input.agentId,
        scheduleKind: input.kind,
    };
}

export function validateScheduleDispatchInput(value: unknown): ScheduleDispatchInput {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new NonRetryableError('SCHEDULE_INPUT_INVALID');
    }
    const raw = value as Record<string, unknown>;
    if (
        raw.schemaVersion !== SCHEDULE_SCHEMA_VERSION ||
        typeof raw.scheduleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(raw.scheduleId) ||
        !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 ||
        (raw.kind !== 'once' && raw.kind !== 'cron') ||
        typeof raw.tenantId !== 'string' || raw.tenantId.length === 0 ||
        typeof raw.agentId !== 'string' || raw.agentId.length === 0 ||
        typeof raw.displayName !== 'string' || raw.displayName.trim().length === 0 ||
        !Object.prototype.hasOwnProperty.call(raw, 'input')
    ) {
        throw new NonRetryableError('SCHEDULE_INPUT_INVALID');
    }
    const options = raw.options;
    if (options !== undefined) {
        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw new NonRetryableError('SCHEDULE_INPUT_INVALID');
        }
        const maxTurns = (options as Record<string, unknown>).maxTurns;
        if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || (maxTurns as number) <= 0)) {
            throw new NonRetryableError('SCHEDULE_INPUT_INVALID');
        }
    }
    if (raw.scheduledFor !== undefined && (
        typeof raw.scheduledFor !== 'string' || !Number.isFinite(Date.parse(raw.scheduledFor))
    )) {
        throw new NonRetryableError('SCHEDULE_INPUT_INVALID');
    }
    return raw as ScheduleDispatchInput;
}

export async function executeScheduleDispatch(
    value: unknown,
    ctx: Pick<Context<ScheduleDispatchInput>, 'workflowRunId' | 'additionalMetadata'> &
        Partial<Pick<Context<ScheduleDispatchInput>, 'taskRunExternalId'>>,
    deps: ScheduleDispatchDeps
): Promise<ScheduleDispatchOutput> {
    const input = validateScheduleDispatchInput(value);
    const metadata = ctx.additionalMetadata();
    const expected = scheduleMetadata(input);
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (metadata[key] !== expectedValue) {
            throw new NonRetryableError(`SCHEDULE_METADATA_MISMATCH:${key}`);
        }
    }
    const occurrenceId = ctx.workflowRunId();
    if (!occurrenceId) throw new NonRetryableError('SCHEDULE_OCCURRENCE_ID_UNAVAILABLE');
    const taskRunExternalId = ctx.taskRunExternalId?.();
    const scheduledFor = deps.resolveScheduledFor
        ? await deps.resolveScheduledFor(occurrenceId, taskRunExternalId)
        : input.scheduledFor;
    if (scheduledFor !== undefined && !Number.isFinite(Date.parse(scheduledFor))) {
        throw new NonRetryableError('SCHEDULE_OCCURRENCE_TIME_INVALID');
    }
    const digest = createHash('sha256')
        .update(`${input.tenantId}\0${input.scheduleId}\0${input.revision}\0${occurrenceId}`)
        .digest('hex')
        .slice(0, 40);
    const taskId = `scheduled-${digest}`;
    let result: SubmitTaskResult;
    try {
        result = await deps.submitTask({
            tenantId: input.tenantId,
            taskId,
            agentId: input.agentId,
            input: input.input,
            ...(input.options?.maxTurns !== undefined ? { options: { maxTurns: input.options.maxTurns } } : {}),
            origin: {
                kind: 'schedule',
                scheduleId: input.scheduleId,
                scheduleOccurrenceId: occurrenceId,
                ...(scheduledFor ? { scheduledFor: new Date(scheduledFor).toISOString() } : {}),
            },
        });
    } catch (error) {
        if (
            error instanceof TaskSubmissionError &&
            error.code !== 'TASK_ADMISSION_UNAVAILABLE' &&
            error.code !== 'TASK_SUBMISSION_PUBLISH_TIMEOUT'
        ) {
            throw new NonRetryableError(error.message);
        }
        throw error;
    }
    return { taskId, status: result.status, occurrenceId };
}

export function createScheduleDispatchTask(hatchet: HatchetClient, deps?: ScheduleDispatchDeps) {
    const executionDeps = deps
        ? {
            ...deps,
            resolveScheduledFor: deps.resolveScheduledFor ?? (async (occurrenceId: string, taskRunExternalId?: string) => {
                // Context exposes Hatchet's external workflow-run ID. The v1 runs
                // client resolves that identity; the legacy REST endpoint expects
                // Hatchet's internal UUID and rejects the external ID.
                const details = await hatchet.runs.get(occurrenceId);
                const task = details.tasks.find((candidate) => candidate.taskExternalId === taskRunExternalId) ??
                    details.tasks[0];
                // Immediately after restart Hatchet can briefly expose year-1
                // sentinels on some timestamps. taskInsertedAt is the durable
                // occurrence enqueue time and remains stable across retries.
                for (const occurrenceTime of [
                    task?.taskInsertedAt,
                    details.run.createdAt,
                    task?.startedAt,
                    details.run.startedAt,
                    task?.createdAt,
                ]) {
                    const occurrenceMs = typeof occurrenceTime === 'string' ? Date.parse(occurrenceTime) : Number.NaN;
                    if (Number.isFinite(occurrenceMs) && occurrenceMs >= Date.UTC(2000, 0, 1)) {
                        return occurrenceTime;
                    }
                }
                throw new Error('SCHEDULE_OCCURRENCE_TIME_UNAVAILABLE');
            }),
        }
        : undefined;
    return hatchet.task<ScheduleDispatchInput, ScheduleDispatchOutput>({
        name: SCHEDULE_DISPATCH_TASK_NAME,
        retries: 3,
        fn: async (input, ctx) => {
            if (!executionDeps) throw new NonRetryableError('SCHEDULE_DISPATCH_NOT_REGISTERED');
            return executeScheduleDispatch(input, ctx, executionDeps);
        },
    });
}
