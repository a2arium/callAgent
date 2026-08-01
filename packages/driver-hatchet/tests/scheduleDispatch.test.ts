import { describe, expect, it, jest } from '@jest/globals';
import {
    executeScheduleDispatch,
    scheduleMetadata,
    type ScheduleDispatchInput,
} from '../src/tasks/scheduleDispatch.js';
import { TaskSubmissionError } from '@a2arium/callagent-core';

const input: ScheduleDispatchInput = {
    schemaVersion: 1,
    scheduleId: 'schedule-1',
    revision: 2,
    kind: 'cron',
    tenantId: 'tenant-a',
    agentId: 'lifecycle-sweep',
    displayName: 'Lifecycle sweep',
    input: { dryRun: false },
    options: { maxTurns: 3 },
    scheduledFor: '2026-08-01T00:00:00.000Z',
};

describe('schedule dispatch', () => {
    it('admits one deterministic root with durable schedule provenance', async () => {
        const submitTask = jest.fn(async () => ({ taskId: 'ignored', status: 'duplicate_active' as const }));
        const ctx = {
            workflowRunId: () => 'occurrence-1',
            additionalMetadata: () => scheduleMetadata(input),
        };
        const first = await executeScheduleDispatch(input, ctx as never, { submitTask });
        const second = await executeScheduleDispatch(input, ctx as never, { submitTask });
        expect(first).toEqual(second);
        expect(first).toMatchObject({ status: 'duplicate_active', occurrenceId: 'occurrence-1' });
        expect(first.taskId).toMatch(/^scheduled-[a-f0-9]{40}$/);
        expect(submitTask).toHaveBeenNthCalledWith(1, {
            tenantId: 'tenant-a', taskId: first.taskId, agentId: 'lifecycle-sweep', input: { dryRun: false },
            options: { maxTurns: 3 },
            origin: {
                kind: 'schedule', scheduleId: 'schedule-1', scheduleOccurrenceId: 'occurrence-1',
                scheduledFor: '2026-08-01T00:00:00.000Z',
            },
        });
    });

    it('fails non-retryably when managed metadata disagrees with durable input', async () => {
        await expect(executeScheduleDispatch(input, {
            workflowRunId: () => 'occurrence-1',
            additionalMetadata: () => ({ ...scheduleMetadata(input), tenantId: 'other-tenant' }),
        } as never, { submitTask: jest.fn() as never })).rejects.toMatchObject({
            message: expect.stringContaining('SCHEDULE_METADATA_MISMATCH:tenantId'),
        });
    });

    it('uses occurrence identity so different fires create different task IDs', async () => {
        const submitTask = jest.fn(async (request: any) => ({ taskId: request.taskId, status: 'accepted' as const }));
        const metadata = () => scheduleMetadata(input);
        const first = await executeScheduleDispatch(input, { workflowRunId: () => 'occurrence-1', additionalMetadata: metadata } as never, { submitTask });
        const second = await executeScheduleDispatch(input, { workflowRunId: () => 'occurrence-2', additionalMetadata: metadata } as never, { submitTask });
        expect(first.taskId).not.toBe(second.taskId);
    });

    it('uses the authoritative provider occurrence time instead of stale trigger input', async () => {
        const submitTask = jest.fn(async (request: any) => ({ taskId: request.taskId, status: 'accepted' as const }));
        await executeScheduleDispatch(input, {
            workflowRunId: () => 'occurrence-rescheduled',
            additionalMetadata: () => scheduleMetadata(input),
        } as never, {
            submitTask,
            resolveScheduledFor: async () => '2026-08-02T03:04:05.000Z',
        });
        expect(submitTask).toHaveBeenCalledWith(expect.objectContaining({
            origin: expect.objectContaining({ scheduledFor: '2026-08-02T03:04:05.000Z' }),
        }));
    });

    it('marks permanently unavailable agents non-retryable but lets transient admission failures retry', async () => {
        const ctx = { workflowRunId: () => 'occurrence-1', additionalMetadata: () => scheduleMetadata(input) };
        await expect(executeScheduleDispatch(input, ctx as never, {
            submitTask: async () => { throw new TaskSubmissionError('TASK_SUBMISSION_AGENT_UNAVAILABLE', 'removed'); },
        })).rejects.toMatchObject({ name: 'NonRetryableError' });
        await expect(executeScheduleDispatch(input, ctx as never, {
            submitTask: async () => { throw new TaskSubmissionError('TASK_ADMISSION_UNAVAILABLE', 'database down'); },
        })).rejects.toMatchObject({ name: 'TaskSubmissionError', code: 'TASK_ADMISSION_UNAVAILABLE' });
    });
});
