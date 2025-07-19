import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { MemoryError } from '@callagent/types';
import { prismaMock } from './__mocks__/prisma.js';

describe('MemorySQLAdapter', () => {
    let adapter: MemorySQLAdapter;
    let mockEmbedFunction: jest.MockedFunction<(text: string) => Promise<number[]>>;

    beforeEach(() => {
        adapter = new MemorySQLAdapter(prismaMock);
        mockEmbedFunction = jest.fn<(text: string) => Promise<number[]>>().mockResolvedValue([0.1, 0.2, 0.3]);
    });

    describe('Constructor', () => {
        test('creates adapter without embedding function', () => {
            const adapter = new MemorySQLAdapter(prismaMock);
            expect(adapter).toBeDefined();
            expect(typeof adapter.get).toBe('function');
            expect(typeof adapter.set).toBe('function');
            expect(typeof adapter.getMany).toBe('function');
            expect(typeof adapter.delete).toBe('function');
            expect(typeof adapter.clear).toBe('function');
        });

        test('creates adapter with embedding function', () => {
            const adapter = new MemorySQLAdapter(prismaMock, mockEmbedFunction);
            expect(adapter).toBeDefined();
            expect(adapter.entities).toBeDefined();
        });
    });

    describe('get()', () => {
        test('returns value for existing key', async () => {
            const mockData = [
                {
                    key: 'test-key',
                    value: { foo: 'bar' },
                    tags: [],
                    created_at: new Date(),
                    updated_at: new Date(),
                }
            ];

            prismaMock.$queryRaw.mockResolvedValue(mockData);

            const result = await adapter.get('test-key');

            expect(result).toEqual({ foo: 'bar' });
            expect(prismaMock.$queryRaw).toHaveBeenCalled();
        });

        test('returns undefined for non-existent key', async () => {
            prismaMock.$queryRaw.mockResolvedValue([]);

            const result = await adapter.get('non-existent-key');

            expect(result).toBeUndefined();
        });

        test('returns proxy objects when entity alignment is available', async () => {
            const adapterWithEmbedding = new MemorySQLAdapter(prismaMock, mockEmbedFunction);

            // Mock memory data
            prismaMock.$queryRaw.mockResolvedValueOnce([{
                key: 'event-1',
                value: { venue: 'Main Hall', speaker: 'Dr. Smith' },
                tags: [],
                created_at: new Date(),
                updated_at: new Date(),
            }]);

            // Mock alignment data
            prismaMock.$queryRaw.mockResolvedValueOnce([
                {
                    field_path: 'venue',
                    entity_id: 'entity-1',
                    original_value: 'Main Hall',
                    confidence: 'high',
                    aligned_at: new Date(),
                    canonical_name: 'Main Auditorium'
                }
            ]);

            const result = await adapterWithEmbedding.get('event-1');

            expect(result.venue.toString()).toBe('Main Auditorium');
            expect(result.venue._original).toBe('Main Hall');
            expect(result.venue._wasAligned).toBe(true);
        });
    });

    describe('set()', () => {
        test('stores data without entity alignment', async () => {
            const key = 'test-key';
            const value = { foo: 'bar' };
            const tags = ['tag1', 'tag2'];

            prismaMock.agentMemoryStore.upsert.mockResolvedValue({
                tenantId: 'default',
                key,
                value: value,
                tags,
                createdAt: new Date(),
                updatedAt: new Date(),
                blobData: null,
                blobMetadata: null
            });

            await adapter.set(key, value, { tags });

            expect(prismaMock.agentMemoryStore.upsert).toHaveBeenCalledWith({
                where: {
                    tenantId_key: {
                        tenantId: 'default',
                        key: key
                    }
                },
                update: {
                    value: value,
                    tags: tags,
                    updatedAt: expect.any(Date)
                },
                create: {
                    tenantId: 'default',
                    key: key,
                    value: value,
                    tags: tags,
                    createdAt: expect.any(Date),
                    updatedAt: expect.any(Date)
                }
            });
        });

        test('stores data with entity alignment', async () => {
            const adapterWithEmbedding = new MemorySQLAdapter(prismaMock, mockEmbedFunction);

            // Mock entity service calls for alignment in the correct order
            prismaMock.$queryRaw
                .mockResolvedValueOnce([]) // findSimilarEntities for "Main Hall" - no matches
                .mockResolvedValueOnce([{ id: 'entity-1' }]) // createNewEntity for "Main Hall"
                .mockResolvedValueOnce([]) // findSimilarEntities for "Dr. Smith" - no matches  
                .mockResolvedValueOnce([{ id: 'entity-2' }]); // createNewEntity for "Dr. Smith"

            // Mock the storeAlignment calls
            prismaMock.$executeRaw.mockResolvedValue(1);

            // Mock the main memory storage
            prismaMock.agentMemoryStore.upsert.mockResolvedValue({
                tenantId: 'default',
                key: 'event-1',
                value: { venue: 'Main Hall', speaker: 'Dr. Smith' },
                tags: [],
                createdAt: new Date(),
                updatedAt: new Date(),
                blobData: null,
                blobMetadata: null
            });

            await adapterWithEmbedding.set('event-1',
                { venue: 'Main Hall', speaker: 'Dr. Smith' },
                { entities: { venue: 'location', speaker: 'person' } }
            );

            expect(mockEmbedFunction).toHaveBeenCalledWith('Main Hall');
            expect(mockEmbedFunction).toHaveBeenCalledWith('Dr. Smith');
            expect(prismaMock.agentMemoryStore.upsert).toHaveBeenCalled();
        });

        test('stores data normally when entities provided but no embedding function', async () => {
            // This should go through the regular set path, not entity alignment
            prismaMock.agentMemoryStore.upsert.mockResolvedValue({
                tenantId: 'default',
                key: 'test-key',
                value: { venue: 'Main Hall' },
                tags: [],
                createdAt: new Date(),
                updatedAt: new Date(),
                blobData: null,
                blobMetadata: null
            });

            // The adapter without embedding function should just store normally, not throw
            await adapter.set('test-key', { venue: 'Main Hall' }, {
                entities: { venue: 'location' }
            });

            expect(prismaMock.agentMemoryStore.upsert).toHaveBeenCalled();
        });

        test('handles embedding generation errors gracefully', async () => {
            const adapterWithEmbedding = new MemorySQLAdapter(prismaMock, mockEmbedFunction);
            mockEmbedFunction.mockRejectedValue(new Error('Embedding API failed'));
            prismaMock.$executeRawUnsafe.mockResolvedValue(1);

            // Should not throw, but continue without embedding
            await expect(adapterWithEmbedding.set('test-key', { foo: 'bar' })).resolves.not.toThrow();
        });
    });

    describe('delete()', () => {
        test('deletes memory and associated alignments', async () => {
            prismaMock.$transaction.mockResolvedValue(undefined);

            await adapter.delete('test-key');

            expect(prismaMock.$transaction).toHaveBeenCalled();
        });
    });

    describe('clear()', () => {
        test('clears all data', async () => {
            prismaMock.$transaction.mockResolvedValue(undefined);

            await adapter.clear();

            expect(prismaMock.$transaction).toHaveBeenCalled();
        });
    });

    describe('getMany()', () => {
        test('returns empty array when no results match', async () => {
            // Mock the querySimple method result - it uses $queryRawUnsafe
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);

            const results = await adapter.getMany({ tag: 'non-existent-tag' });

            expect(results).toEqual([]);
        });

        test('returns matching results with tag filter', async () => {
            const mockData = [
                {
                    key: 'key1',
                    value: { data: 'value1' },
                    tags: ['tag1'],
                    created_at: new Date(),
                    updated_at: new Date(),
                }
            ];

            // Mock the querySimple method result - it uses $queryRawUnsafe
            prismaMock.$queryRawUnsafe.mockResolvedValue(mockData);

            const results = await adapter.getMany({ tag: 'tag1' });

            expect(results).toEqual([{ key: 'key1', value: { data: 'value1' } }]);
        });

        test('respects limit parameter', async () => {
            // Mock the querySimple method result - it uses $queryRawUnsafe
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);

            await adapter.getMany({ tag: 'test', limit: 5 });

            expect(prismaMock.$queryRawUnsafe).toHaveBeenCalled();
        });

        test('rejects unsupported features', async () => {
            await expect(adapter.getMany({
                similarityVector: [0.1, 0.2, 0.3]
            } as any)).rejects.toThrow(/Vector search is not supported/);

            await expect(adapter.getMany({
                orderBy: { path: 'createdAt', direction: 'desc' }
            } as any)).rejects.toThrow(/Sorting by JSON paths not implemented/);
        });

        describe('with filters', () => {
            test('applies equality filter', async () => {
                prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

                await adapter.getMany({
                    filters: [{ path: 'status', operator: '=', value: 'active' }]
                });

                expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: expect.objectContaining({
                            AND: expect.arrayContaining([
                                expect.objectContaining({
                                    value: expect.objectContaining({
                                        path: ['status'],
                                        equals: 'active'
                                    })
                                })
                            ])
                        })
                    })
                );
            });

            test('applies string operators', async () => {
                prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

                await adapter.getMany({
                    filters: [{ path: 'name', operator: 'CONTAINS', value: 'John' }]
                });

                expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith(
                    expect.objectContaining({
                        where: expect.objectContaining({
                            AND: expect.arrayContaining([
                                expect.objectContaining({
                                    value: expect.objectContaining({
                                        path: ['name'],
                                        string_contains: 'John'
                                    })
                                })
                            ])
                        })
                    })
                );
            });

            test('validates filter inputs', async () => {
                await expect(adapter.getMany({
                    filters: [{ path: 'status', operator: 'INVALID' as any, value: 'active' }]
                })).rejects.toThrow(/Invalid filter/);

                await expect(adapter.getMany({
                    filters: [{ path: '', operator: '=', value: 'active' }]
                })).rejects.toThrow(/Invalid filter/);

                await expect(adapter.getMany({
                    filters: [{ path: 'name', operator: 'CONTAINS', value: 123 }]
                })).rejects.toThrow(/CONTAINS operator requires a string value/);
            });
        });
    });

    describe('entities property', () => {
        test('throws error when no embedding function provided', () => {
            expect(() => adapter.entities).toThrow('Entity alignment not available');
        });

        test('provides entity management interface when embedding function provided', () => {
            const adapterWithEmbedding = new MemorySQLAdapter(prismaMock, mockEmbedFunction);
            const entities = adapterWithEmbedding.entities;

            expect(entities).toBeDefined();
            expect(typeof entities.unlink).toBe('function');
            expect(typeof entities.realign).toBe('function');
            expect(typeof entities.stats).toBe('function');
        });

        test('unlink method works', async () => {
            const adapterWithEmbedding = new MemorySQLAdapter(prismaMock, mockEmbedFunction);
            prismaMock.$executeRaw.mockResolvedValue(1);

            await adapterWithEmbedding.entities.unlink('memory-1', 'venue');

            expect(prismaMock.$executeRaw).toHaveBeenCalled();
        });

        test('stats method returns entity statistics', async () => {
            const adapterWithEmbedding = new MemorySQLAdapter(prismaMock, mockEmbedFunction);

            // Mock the three queries that stats() makes in the correct order
            // getEntityStats uses $queryRawUnsafe for the first query and $queryRaw for the others
            prismaMock.$queryRawUnsafe
                .mockResolvedValueOnce([{ count: '8' }]); // Total entities

            prismaMock.$queryRaw
                .mockResolvedValueOnce([{ count: '12' }]) // Total alignments  
                .mockResolvedValueOnce([ // Entities by type
                    { entity_type: 'location', count: '5' },
                    { entity_type: 'person', count: '3' }
                ]);

            const stats = await adapterWithEmbedding.entities.stats();

            expect(stats).toEqual({
                totalEntities: 8,
                totalAlignments: 12,
                entitiesByType: {
                    location: 5,
                    person: 3
                }
            });
        });
    });
}); 