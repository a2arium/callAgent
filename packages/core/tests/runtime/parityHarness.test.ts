import { describe, expect, it } from '@jest/globals';
import { createBusEvent } from '../../src/eventbus/busEventHelpers.js';
import { normalizeRuntimeEvent } from './parityHarness.js';

describe('runtime parity harness', () => {
    it('normalizes volatile runtime event fields', () => {
        const event = createBusEvent({
            channel: 'task.task-1.events',
            cloud: {
                id: 'evt-1',
                type: 'task.status',
                source: '/tasks/task-1',
                time: '2026-01-01T00:00:00.000Z',
                datacontenttype: 'application/json',
                data: {
                    id: 'task-1',
                    final: false,
                    status: {
                        state: 'working',
                        timestamp: '2026-01-01T00:00:00.000Z',
                        message: { role: 'agent', parts: [{ type: 'text', text: 'hello' }] },
                    },
                },
            },
        });

        expect(normalizeRuntimeEvent(event)).toEqual({
            type: 'task.status',
            final: false,
            state: 'working',
            taskId: 'task-1',
            hasMessage: true,
        });
    });
});
