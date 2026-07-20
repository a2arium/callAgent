import { describe, expect, it, jest } from '@jest/globals';
import { createTerminalDeliveryGate } from '../src/runner/terminalDeliveryGate.js';

describe('terminal delivery gate', () => {
    it('delivers event-bus and direct snapshot paths once by durable delivery key', () => {
        const deliver = jest.fn();
        const gate = createTerminalDeliveryGate(deliver);
        const status = {
            state: 'completed' as const,
            metadata: { result: { ok: false, error: { code: 'FETCH_FAILED' } } },
        };

        expect(gate({ deliveryKey: 'task-1:terminal:completed', status })).toBe(true);
        expect(gate({ deliveryKey: 'task-1:terminal:completed', status })).toBe(false);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
    });
});
