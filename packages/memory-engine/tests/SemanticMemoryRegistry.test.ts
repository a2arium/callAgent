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

    it('returns undefined when the selected backend has no atomic capability', () => {
        const registry = new SemanticMemoryRegistry({ mlo: {} as any }, 'mlo');
        expect(registry.getAtomic()).toBeUndefined();
    });

    it('binds atomic operations to an explicitly selected backend and emits only successful events', async () => {
        const events: SemanticMemoryEvent[] = [];
        const compareAndSet = jest.fn(async ({ expectedVersion }: { expectedVersion: string | null }) =>
            expectedVersion === '4'
                ? { status: 'updated' as const, version: '5' }
                : { status: 'conflict' as const, currentVersion: '5' }
        );
        const registry = new SemanticMemoryRegistry(
            {
                mlo: {} as any,
                sql: {
                    atomic: {
                        getVersioned: jest.fn(async () => ({ value: { active: 4 }, version: '4' })),
                        compareAndSet,
                    },
                } as any,
            },
            'mlo',
            (event) => events.push(event)
        );

        const atomic = registry.getAtomic({ backend: 'sql' });
        expect(atomic).toBeDefined();
        await expect(atomic!.getVersioned('site:active')).resolves.toEqual({ value: { active: 4 }, version: '4' });
        await expect(atomic!.compareAndSet({ key: 'site:active', expectedVersion: '4', value: { active: 5 } }))
            .resolves.toEqual({ status: 'updated', version: '5' });
        await expect(atomic!.compareAndSet({ key: 'site:active', expectedVersion: '3', value: { active: 6 } }))
            .resolves.toEqual({ status: 'conflict', currentVersion: '5' });

        expect(events).toEqual([
            { op: 'read', keys: ['site:active'], backend: 'sql', source: 'context.memory' },
            { op: 'write', keys: ['site:active'], backend: 'sql', source: 'context.memory' },
        ]);
    });

    it('throws the registry error for an unknown atomic backend', () => {
        const registry = new SemanticMemoryRegistry({ sql: {} as any }, 'sql');
        expect(() => registry.getAtomic({ backend: 'missing' })).toThrow('No such backend: missing');
    });
});
