import { describe, expect, it, jest } from '@jest/globals';
import { SemanticMemoryRegistry, type SemanticMemoryEvent } from '../src/types/semantic/SemanticMemoryRegistry.js';

describe('SemanticMemoryRegistry', () => {
    it('supports high-level add() and emits an operator write event', async () => {
        const set = jest.fn(async () => undefined);
        const events: SemanticMemoryEvent[] = [];
        const registry = new SemanticMemoryRegistry(
            {
                sql: {
                    get: jest.fn(async () => null),
                    set,
                    delete: jest.fn(async () => undefined),
                    recognize: jest.fn(async () => ({ recognized: false })),
                    enrich: jest.fn(async () => ({ enriched: false })),
                } as any,
            },
            'sql',
            (event) => events.push(event)
        );

        await registry.add({
            id: 'selectors:cian',
            value: { container: '.item' },
            tags: ['selectors', 'cian'],
            entities: { siteId: 'cian' },
        });

        expect(set).toHaveBeenCalledWith(
            'selectors:cian',
            { container: '.item' },
            { tags: ['selectors', 'cian'], entities: { siteId: 'cian' } }
        );
        expect(events).toEqual([
            {
                op: 'write',
                keys: ['selectors:cian'],
                backend: 'sql',
                source: 'context.memory',
            },
        ]);
    });
});
