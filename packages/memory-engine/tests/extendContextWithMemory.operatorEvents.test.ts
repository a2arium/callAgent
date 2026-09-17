import { jest, describe, expect, it } from '@jest/globals';

const mockWorkingMemorySQLAdapter = jest.fn();

await jest.unstable_mockModule('@a2arium/callagent-memory-sql', () => ({
    WorkingMemorySQLAdapter: mockWorkingMemorySQLAdapter,
}));

const { extendContextWithMemory } = await import('../src/types/working/context/workingMemoryContext.js');

describe('extendContextWithMemory operator memory events', () => {
    it('resolves the operator event sink at write time', async () => {
        const semanticSet = jest.fn(async () => undefined);
        const context = {} as any;
        await extendContextWithMemory(
            context,
            'default',
            'discover-listing-selectors',
            { memory: { profile: 'basic' } },
            {
                get: jest.fn(async () => null),
                set: semanticSet,
                delete: jest.fn(async () => undefined),
                recognize: jest.fn(async () => ({ recognized: false })),
                enrich: jest.fn(async () => ({ enriched: false })),
            },
            { isMockPrisma: true }
        );

        const events: unknown[] = [];
        context.__operatorMemoryEvent = (event: unknown) => events.push(event);

        await context.memory.semantic.add({
            id: 'selectors:run-1',
            value: { container: '.listing' },
            tags: ['selectors', 'run-1'],
        });

        expect(semanticSet).toHaveBeenCalledWith(
            'selectors:run-1',
            { container: '.listing' },
            { tags: ['selectors', 'run-1'], entities: undefined }
        );
        expect(events).toEqual([
            {
                op: 'write',
                keys: ['selectors:run-1'],
                backend: 'mlo',
                source: 'context.memory',
            },
        ]);
    });
});
