import { describe, expect, it } from '@jest/globals';
import { mapA2AEventToRuntimeStream } from '../src/streaming/a2aMapper.js';
import { isTerminalRuntimeStreamStatus } from '../src/streaming/runtimeStreamEvents.js';
import type { A2AEvent } from '../src/shared/types/StreamingEvents.js';

const options = {
    id: 'evt-1',
    seq: 0,
    ts: '2026-05-03T00:00:00.000Z',
    tenantId: 'tenant-test',
    agentId: 'agent-test',
};

describe('mapA2AEventToRuntimeStream', () => {
    it('maps working status to non-terminal task.status', () => {
        const mapped = mapA2AEventToRuntimeStream({
            id: 'task-1',
            status: { state: 'working', timestamp: options.ts },
            final: false,
        }, options);

        expect(mapped).toHaveLength(1);
        expect(mapped[0]).toMatchObject({
            type: 'task.status',
            taskId: 'task-1',
            visibility: 'public',
            data: { state: 'working', terminal: false },
        });
        expect(isTerminalRuntimeStreamStatus(mapped[0])).toBe(false);
    });

    it('maps completed status to terminal task.status', () => {
        const mapped = mapA2AEventToRuntimeStream({
            id: 'task-1',
            status: { state: 'completed', timestamp: options.ts },
            final: true,
        }, options);

        expect(mapped).toHaveLength(1);
        expect(mapped[0]).toMatchObject({
            type: 'task.status',
            data: { state: 'completed', terminal: true },
        });
        expect(isTerminalRuntimeStreamStatus(mapped[0])).toBe(true);
    });

    it('maps input-required status to input.required plus non-terminal status when token and parts exist', () => {
        const mapped = mapA2AEventToRuntimeStream({
            id: 'task-1',
            status: {
                state: 'input-required',
                timestamp: options.ts,
                message: { role: 'agent', parts: [{ type: 'text', text: 'Need city?' }] },
                metadata: { token: 'tok-1' },
            },
            final: false,
        } as A2AEvent, options);

        expect(mapped.map((event) => event.type)).toEqual(['input.required', 'task.status']);
        expect(mapped[0]).toMatchObject({
            id: 'evt-1:input-required',
            seq: 1,
            data: { token: 'tok-1' },
        });
        expect(mapped[1]).toMatchObject({
            id: 'evt-1',
            seq: 0,
            data: { state: 'input-required', terminal: false },
        });
    });

    it('maps artifact event to artifact.delta', () => {
        const mapped = mapA2AEventToRuntimeStream({
            id: 'task-1',
            artifact: {
                name: 'response',
                index: 0,
                append: false,
                parts: [{ type: 'text', text: 'hello', format: 'markdown' }],
            },
            final: false,
        } as A2AEvent, options);

        expect(mapped).toHaveLength(1);
        expect(mapped[0]).toMatchObject({
            type: 'artifact.delta',
            data: {
                artifactId: 'response',
                index: 0,
                append: false,
            },
        });
    });

    it('maps lastChunk artifact event to delta plus artifact.done without terminal task status', () => {
        const mapped = mapA2AEventToRuntimeStream({
            id: 'task-1',
            artifact: {
                name: 'response',
                index: 0,
                append: true,
                lastChunk: true,
                parts: [{ type: 'text', text: 'hello' }],
            },
            final: true,
        } as A2AEvent, options);

        expect(mapped.map((event) => event.type)).toEqual(['artifact.delta', 'artifact.done']);
        expect(mapped.some(isTerminalRuntimeStreamStatus)).toBe(false);
        expect(mapped[1]).toMatchObject({
            id: 'evt-1:artifact-done',
            seq: 1,
            data: { artifactId: 'response', index: 0 },
        });
    });
});

