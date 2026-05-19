import { describe, expect, it } from '@jest/globals';
import {
    RUNTIME_STREAM_EVENT_VERSION,
    RuntimeStreamEventSchema,
    isTerminalRuntimeStreamStatus,
    type RuntimeStreamEvent,
} from '../src/streaming/runtimeStreamEvents.js';

const base = {
    version: RUNTIME_STREAM_EVENT_VERSION,
    id: 'evt-1',
    seq: 0,
    taskId: 'task-1',
    tenantId: 'tenant-test',
    agentId: 'agent-test',
    ts: '2026-05-03T00:00:00.000Z',
} as const;

describe('RuntimeStreamEventSchema', () => {
    it('parses a public artifact delta event', () => {
        const parsed = RuntimeStreamEventSchema.parse({
            ...base,
            type: 'artifact.delta',
            visibility: 'public',
            channel: 'user',
            data: {
                artifactId: 'response',
                name: 'response',
                index: 0,
                append: false,
                parts: [{ type: 'text', text: 'hello', format: 'markdown' }],
            },
        });

        expect(parsed.type).toBe('artifact.delta');
        expect(parsed.data.parts[0].type).toBe('text');
    });

    it('parses debug and private events without exposing them as public', () => {
        const tool = RuntimeStreamEventSchema.parse({
            ...base,
            id: 'evt-tool',
            type: 'tool.started',
            visibility: 'debug',
            channel: 'debug',
            data: {
                token: 'tool-1',
                toolName: 'search',
                argsPreview: { q: 'Tallinn' },
            },
        });

        const thought = RuntimeStreamEventSchema.parse({
            ...base,
            id: 'evt-thought',
            seq: 1,
            type: 'thought.added',
            visibility: 'private',
            channel: 'telemetry',
            data: {
                thoughtId: 'thought-1',
                preview: 'Need tool result.',
            },
        });

        expect(tool.visibility).toBe('debug');
        expect(thought.visibility).toBe('private');
    });

    it('rejects unknown event types', () => {
        const parsed = RuntimeStreamEventSchema.safeParse({
            ...base,
            type: 'unknown.event',
            visibility: 'public',
            data: {},
        });

        expect(parsed.success).toBe(false);
    });

    it('rejects artifact.done with extra terminal data', () => {
        const parsed = RuntimeStreamEventSchema.safeParse({
            ...base,
            type: 'artifact.done',
            visibility: 'public',
            channel: 'user',
            data: {
                artifactId: 'response',
                index: 0,
                terminal: true,
            },
        });

        expect(parsed.success).toBe(false);
    });

    it('recognizes only terminal task statuses as stream terminal', () => {
        const completed = RuntimeStreamEventSchema.parse({
            ...base,
            type: 'task.status',
            visibility: 'public',
            channel: 'user',
            data: {
                state: 'completed',
                terminal: true,
            },
        });

        const inputRequired = RuntimeStreamEventSchema.parse({
            ...base,
            id: 'evt-input',
            seq: 1,
            type: 'task.status',
            visibility: 'public',
            channel: 'user',
            data: {
                state: 'input-required',
                terminal: false,
            },
        });

        expect(isTerminalRuntimeStreamStatus(completed)).toBe(true);
        expect(isTerminalRuntimeStreamStatus(inputRequired)).toBe(false);
    });

    it('keeps inferred types tied to schema output', () => {
        const event: RuntimeStreamEvent = RuntimeStreamEventSchema.parse({
            ...base,
            type: 'input.required',
            visibility: 'public',
            channel: 'user',
            data: {
                token: 'tok-1',
                parts: [{ type: 'text', text: 'Need more info' }],
            },
        });

        expect(event.type).toBe('input.required');
        if (event.type === 'input.required') {
            expect(event.data.token).toBe('tok-1');
        }
    });
});

