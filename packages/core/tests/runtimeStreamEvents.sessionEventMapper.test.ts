import { describe, expect, it } from '@jest/globals';
import { mapWorkingMemoryEventToRuntimeStream } from '../src/streaming/sessionEventMapper.js';

describe('mapWorkingMemoryEventToRuntimeStream', () => {
    it('maps persisted tool requests to canonical debug tool.started events', () => {
        const mapped = mapWorkingMemoryEventToRuntimeStream({
            eventId: 'wm-1',
            seq: 7,
            type: 'task.tool_requested',
            createdAt: '2026-05-03T00:00:00.000Z',
            payload: {
                token: 'tool-1',
                toolName: 'search',
                argsPreview: { q: 'Tallinn' },
            },
        }, {
            taskId: 'task-1',
            tenantId: 'tenant-test',
            agentId: 'agent-test',
        });

        expect(mapped).toEqual([expect.objectContaining({
            id: 'wm-1',
            seq: 7,
            taskId: 'task-1',
            tenantId: 'tenant-test',
            agentId: 'agent-test',
            type: 'tool.started',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token: 'tool-1',
                toolName: 'search',
                argsPreview: { q: 'Tallinn' },
            },
        })]);
    });

    it('maps persisted tool completions to canonical debug tool.completed events', () => {
        const mapped = mapWorkingMemoryEventToRuntimeStream({
            eventId: 'wm-2',
            seq: 8,
            type: 'task.tool_completed',
            createdAt: '2026-05-03T00:00:01.000Z',
            payload: {
                token: 'tool-1',
                toolName: 'search',
                resultPreview: { answer: 'Tallinn' },
            },
        }, {
            taskId: 'task-1',
            tenantId: 'tenant-test',
        });

        expect(mapped).toEqual([expect.objectContaining({
            id: 'wm-2',
            seq: 8,
            taskId: 'task-1',
            tenantId: 'tenant-test',
            type: 'tool.completed',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token: 'tool-1',
                toolName: 'search',
                status: 'completed',
                resultPreview: { answer: 'Tallinn' },
            },
        })]);
    });

    it('keeps malformed or unsupported session events out of the runtime stream', () => {
        expect(mapWorkingMemoryEventToRuntimeStream({
            eventId: 'wm-3',
            seq: 9,
            type: 'task.tool_completed',
            createdAt: '2026-05-03T00:00:02.000Z',
            payload: { token: 'tool-1' },
        }, { taskId: 'task-1' })).toEqual([]);

        expect(mapWorkingMemoryEventToRuntimeStream({
            eventId: 'wm-4',
            seq: 10,
            type: 'task.other',
            createdAt: '2026-05-03T00:00:03.000Z',
            payload: {},
        }, { taskId: 'task-1' })).toEqual([]);
    });

    it('maps persisted child lifecycle events to canonical debug child events', () => {
        const started = mapWorkingMemoryEventToRuntimeStream({
            eventId: 'wm-child-1',
            seq: 11,
            type: 'task.child_started',
            createdAt: '2026-05-03T00:00:04.000Z',
            payload: {
                token: 'child-1',
                agentId: 'research-agent',
            },
        }, {
            taskId: 'task-1',
            tenantId: 'tenant-test',
        });

        const completed = mapWorkingMemoryEventToRuntimeStream({
            eventId: 'wm-child-2',
            seq: 12,
            type: 'task.child_completed',
            createdAt: '2026-05-03T00:00:05.000Z',
            payload: {
                token: 'child-1',
                agentId: 'research-agent',
                childTaskId: 'task-child-1',
                resultPreview: { ok: true },
            },
        }, {
            taskId: 'task-1',
            tenantId: 'tenant-test',
        });

        expect(started).toEqual([expect.objectContaining({
            id: 'wm-child-1',
            seq: 11,
            taskId: 'task-1',
            type: 'child.started',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token: 'child-1',
                agentId: 'research-agent',
            },
        })]);
        expect(completed).toEqual([expect.objectContaining({
            id: 'wm-child-2',
            seq: 12,
            taskId: 'task-1',
            type: 'child.completed',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token: 'child-1',
                agentId: 'research-agent',
                childTaskId: 'task-child-1',
                status: 'completed',
                resultPreview: { ok: true },
            },
        })]);
    });

    it('maps persisted child failures to failed canonical child.completed events', () => {
        const mapped = mapWorkingMemoryEventToRuntimeStream({
            eventId: 'wm-child-failed',
            seq: 13,
            type: 'task.child_failed',
            createdAt: '2026-05-03T00:00:06.000Z',
            payload: {
                token: 'child-1',
                agentId: 'research-agent',
                childTaskId: 'task-child-1',
                error: 'child failed',
            },
        }, {
            taskId: 'task-1',
            tenantId: 'tenant-test',
        });

        expect(mapped).toEqual([expect.objectContaining({
            id: 'wm-child-failed',
            seq: 13,
            type: 'child.completed',
            visibility: 'debug',
            data: {
                token: 'child-1',
                agentId: 'research-agent',
                childTaskId: 'task-child-1',
                status: 'failed',
                error: { message: 'child failed' },
            },
        })]);
    });

    it('maps persisted child input-required events to canonical debug child.message events', () => {
        const mapped = mapWorkingMemoryEventToRuntimeStream({
            eventId: 'wm-child-input',
            seq: 14,
            type: 'task.child_input_required',
            createdAt: '2026-05-03T00:00:07.000Z',
            payload: {
                token: 'child-1',
                agentId: 'research-agent',
                childTaskId: 'task-child-1',
                prompt: 'Need approval?',
                schema: { type: 'boolean' },
            },
        }, {
            taskId: 'task-1',
            tenantId: 'tenant-test',
        });

        expect(mapped).toEqual([expect.objectContaining({
            id: 'wm-child-input',
            seq: 14,
            type: 'child.message',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token: 'child-1',
                agentId: 'research-agent',
                childTaskId: 'task-child-1',
                parts: [{ type: 'text', text: 'Need approval?' }],
            },
        })]);
    });
});
