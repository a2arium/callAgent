import { describe, expect, it } from '@jest/globals';
import {
    RUNTIME_STREAM_EVENT_VERSION,
    RuntimeStreamEventSchema,
    type RuntimeStreamEvent,
} from '../src/streaming/runtimeStreamEvents.js';
import {
    projectRuntimeStreamChat,
    projectRuntimeStreamDebug,
    projectRuntimeStreamPublic,
    projectRuntimeStreamSse,
} from '../src/streaming/projections.js';

const event = (candidate: unknown): RuntimeStreamEvent => RuntimeStreamEventSchema.parse(candidate);

const base = {
    version: RUNTIME_STREAM_EVENT_VERSION,
    taskId: 'task-1',
    tenantId: 'tenant-test',
    agentId: 'agent-test',
} as const;

const sampleEvents = (): RuntimeStreamEvent[] => [
    event({
        ...base,
        id: 'evt-0',
        seq: 0,
        ts: '2026-05-03T00:00:00.000Z',
        type: 'task.status',
        visibility: 'public',
        channel: 'user',
        data: { state: 'working', terminal: false },
    }),
    event({
        ...base,
        id: 'evt-1',
        seq: 1,
        ts: '2026-05-03T00:00:00.010Z',
        type: 'tool.started',
        visibility: 'debug',
        channel: 'debug',
        data: { token: 'tool-1', toolName: 'search', argsPreview: { q: 'Tallinn' } },
    }),
    event({
        ...base,
        id: 'evt-2',
        seq: 2,
        ts: '2026-05-03T00:00:00.020Z',
        type: 'thought.added',
        visibility: 'private',
        channel: 'telemetry',
        data: { thoughtId: 'thought-1', preview: 'Need tool result.' },
    }),
    event({
        ...base,
        id: 'evt-3',
        seq: 3,
        ts: '2026-05-03T00:00:00.030Z',
        type: 'artifact.delta',
        visibility: 'public',
        channel: 'user',
        data: {
            artifactId: 'response',
            index: 0,
            append: false,
            parts: [{ type: 'text', text: 'Tallinn is 12 C.', format: 'markdown' }],
        },
    }),
    event({
        ...base,
        id: 'evt-4',
        seq: 4,
        ts: '2026-05-03T00:00:00.040Z',
        type: 'artifact.done',
        visibility: 'public',
        channel: 'user',
        data: { artifactId: 'response', index: 0 },
    }),
    event({
        ...base,
        id: 'evt-5',
        seq: 5,
        ts: '2026-05-03T00:00:00.050Z',
        type: 'task.status',
        visibility: 'public',
        channel: 'user',
        data: { state: 'completed', terminal: true },
    }),
];

describe('runtime stream projections', () => {
    it('filters public events only', () => {
        const projected = projectRuntimeStreamPublic(sampleEvents());

        expect(projected.map((e) => e.id)).toEqual(['evt-0', 'evt-3', 'evt-4', 'evt-5']);
        expect(projected.every((e) => e.visibility === 'public')).toBe(true);
    });

    it('filters debug events without leaking private events', () => {
        const projected = projectRuntimeStreamDebug(sampleEvents());

        expect(projected.map((e) => e.id)).toEqual(['evt-0', 'evt-1', 'evt-3', 'evt-4', 'evt-5']);
        expect(projected.some((e) => e.visibility === 'private')).toBe(false);
    });

    it('projects SSE closure only for terminal task statuses', () => {
        const projected = projectRuntimeStreamSse(sampleEvents());

        expect(projected.find((e) => e.data.type === 'artifact.done')?.closesStream).toBe(false);
        expect(projected.filter((e) => e.closesStream).map((e) => e.id)).toEqual(['evt-5']);
    });

    it('projects public chat events', () => {
        const projected = projectRuntimeStreamChat(sampleEvents());

        expect(projected).toEqual([
            { type: 'typing', taskId: 'task-1', seq: 0, ts: '2026-05-03T00:00:00.000Z' },
            {
                type: 'message',
                taskId: 'task-1',
                seq: 3,
                ts: '2026-05-03T00:00:00.030Z',
                text: 'Tallinn is 12 C.',
                parseMode: 'markdown',
            },
            { type: 'completed', taskId: 'task-1', seq: 5, ts: '2026-05-03T00:00:00.050Z' },
        ]);
    });

    it('projects input-required prompts for chat', () => {
        const events = [
            event({
                ...base,
                id: 'evt-input',
                seq: 0,
                ts: '2026-05-03T00:00:00.000Z',
                type: 'input.required',
                visibility: 'public',
                channel: 'user',
                data: {
                    token: 'tok-1',
                    parts: [{ type: 'text', text: 'What city?', format: 'markdown' }],
                },
            }),
        ];

        expect(projectRuntimeStreamChat(events)).toEqual([
            {
                type: 'input_required',
                taskId: 'task-1',
                seq: 0,
                ts: '2026-05-03T00:00:00.000Z',
                token: 'tok-1',
                prompt: 'What city?',
            },
        ]);
    });
});

