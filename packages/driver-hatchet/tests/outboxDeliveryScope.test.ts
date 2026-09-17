import { describe, expect, it } from '@jest/globals';
import { assertSharedOutboxEventBus } from '../src/createHatchetOutboxStack.js';

describe('Hatchet outbox transport configuration', () => {
    it('rejects a process-local event bus', () => {
        expect(() => assertSharedOutboxEventBus({
            deliveryScope: 'process',
            publish: async () => undefined,
            subscribe: async () => ({ unsubscribe: async () => undefined }),
        })).toThrow(
            'Hatchet outbox workers require an event bus with deliveryScope="shared"'
        );
    });

    it('accepts a shared event bus capability', () => {
        expect(() => assertSharedOutboxEventBus({
            deliveryScope: 'shared',
            publish: async () => undefined,
            subscribe: async () => ({ unsubscribe: async () => undefined }),
        })).not.toThrow();
    });
});
