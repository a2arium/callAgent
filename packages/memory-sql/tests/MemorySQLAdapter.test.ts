import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { MemoryError } from '@callagent/types';
import { PrismaClient } from '@prisma/client';
import { prismaMock } from './mock-client.js';

describe('MemorySQLAdapter', () => {
    let adapter: MemorySQLAdapter;

    beforeEach(() => {
        adapter = new MemorySQLAdapter(prismaMock);
    });

    describe('get()', () => {
        test('returns value for existing key', async () => {
            const mockData = {
                key: 'test-key',
                value: { foo: 'bar' },
                tags: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            prismaMock.agentMemoryStore.findUnique.mockResolvedValue(mockData);

            const result = await adapter.get('test-key');

            expect(result).toEqual(mockData.value);
            expect(prismaMock.agentMemoryStore.findUnique).toHaveBeenCalledWith({
                where: { key: 'test-key' }
            });
        });

        test('returns null for non-existent key', async () => {
            prismaMock.agentMemoryStore.findUnique.mockResolvedValue(null);

            const result = await adapter.get('non-existent-key');

            expect(result).toBeNull();
            expect(prismaMock.agentMemoryStore.findUnique).toHaveBeenCalledWith({
                where: { key: 'non-existent-key' }
            });
        });

        test('throws MemoryError on database error', async () => {
            const dbError = new Error('Database connection failed');
            prismaMock.agentMemoryStore.findUnique.mockRejectedValue(dbError);

            await expect(adapter.get('test-key')).rejects.toThrow(MemoryError);
            await expect(adapter.get('test-key')).rejects.toThrow(/Failed to get key 'test-key'/);
        });
    });

    describe('set()', () => {
        test('correctly upserts data with tags', async () => {
            const key = 'test-key';
            const value = { foo: 'bar' };
            const tags = ['tag1', 'tag2'];

            await adapter.set(key, value, { tags });

            expect(prismaMock.agentMemoryStore.upsert).toHaveBeenCalledWith({
                where: { key },
                create: { key, value, tags },
                update: { value, tags }
            });
        });

        test('uses empty tags array when no tags provided', async () => {
            const key = 'test-key';
            const value = { foo: 'bar' };

            await adapter.set(key, value);

            expect(prismaMock.agentMemoryStore.upsert).toHaveBeenCalledWith({
                where: { key },
                create: { key, value, tags: [] },
                update: { value, tags: [] }
            });
        });

        test('throws MemoryError on database error', async () => {
            const dbError = new Error('Database constraint violation');
            prismaMock.agentMemoryStore.upsert.mockRejectedValue(dbError);

            await expect(adapter.set('test-key', { foo: 'bar' })).rejects.toThrow(MemoryError);
            await expect(adapter.set('test-key', { foo: 'bar' })).rejects.toThrow(/Failed to set key 'test-key'/);
        });
    });

    describe('delete()', () => {
        test('successfully deletes existing key', async () => {
            await adapter.delete('test-key');

            expect(prismaMock.agentMemoryStore.delete).toHaveBeenCalledWith({
                where: { key: 'test-key' }
            });
        });

        test('handles non-existent key deletion gracefully', async () => {
            const notFoundError: any = new Error('Record not found');
            notFoundError.name = 'PrismaClientKnownRequestError';
            notFoundError.code = 'P2025';

            prismaMock.agentMemoryStore.delete.mockRejectedValue(notFoundError);

            // Should not throw an error
            await expect(adapter.delete('non-existent-key')).resolves.not.toThrow();
        });

        test('throws MemoryError on database error', async () => {
            const dbError = new Error('Database connection failed');
            prismaMock.agentMemoryStore.delete.mockRejectedValue(dbError);

            await expect(adapter.delete('test-key')).rejects.toThrow(MemoryError);
            await expect(adapter.delete('test-key')).rejects.toThrow(/Failed to delete key 'test-key'/);
        });
    });

    describe('query()', () => {
        test('returns empty array when no results match', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            const results = await adapter.query({ tag: 'non-existent-tag' });

            expect(results).toEqual([]);
            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: { tags: { has: 'non-existent-tag' } }
            });
        });

        test('returns matching results with tag filter', async () => {
            const mockData = [
                {
                    key: 'key1',
                    value: { data: 'value1' },
                    tags: ['tag1', 'common'],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
                {
                    key: 'key2',
                    value: { data: 'value2' },
                    tags: ['tag1', 'special'],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }
            ];

            prismaMock.agentMemoryStore.findMany.mockResolvedValue(mockData);

            const results = await adapter.query({ tag: 'tag1' });

            expect(results).toEqual([
                { key: 'key1', value: { data: 'value1' } },
                { key: 'key2', value: { data: 'value2' } }
            ]);

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: { tags: { has: 'tag1' } }
            });
        });

        test('respects limit option', async () => {
            // Mock an empty array return to avoid the error
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({ limit: 5 });

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                take: 5
            });
        });

        test('throws error when similarityVector is provided', async () => {
            await expect(adapter.query({
                similarityVector: [0.1, 0.2, 0.3]
            })).rejects.toThrow(/Vector search is not supported/);
        });

        test('throws MemoryError on database error', async () => {
            const dbError = new Error('Database connection failed');
            prismaMock.agentMemoryStore.findMany.mockRejectedValue(dbError);

            await expect(adapter.query({})).rejects.toThrow(MemoryError);
            await expect(adapter.query({})).rejects.toThrow(/Failed to query memory/);
        });
    });

    describe('query() with filters', () => {
        test('applies equality filter on JSON field', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({
                filters: [{ path: 'status', operator: '=', value: 'active' }]
            });

            // Verify correct Prisma query was built
            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: {
                    AND: [
                        {
                            value: {
                                path: ['status'],
                                equals: 'active'
                            }
                        }
                    ]
                }
            });
        });

        test('applies inequality filter on JSON field', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({
                filters: [{ path: 'status', operator: '!=', value: 'inactive' }]
            });

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: {
                    AND: [
                        {
                            NOT: {
                                value: {
                                    path: ['status'],
                                    equals: 'inactive'
                                }
                            }
                        }
                    ]
                }
            });
        });

        test('applies numeric comparison filters on JSON field', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({
                filters: [{ path: 'priority', operator: '>', value: 5 }]
            });

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: {
                    AND: [
                        {
                            value: {
                                path: ['priority'],
                                gt: 5
                            }
                        }
                    ]
                }
            });
        });

        test('applies string operators on JSON field', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({
                filters: [{ path: 'name', operator: 'CONTAINS', value: 'John' }]
            });

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: {
                    AND: [
                        {
                            value: {
                                path: ['name'],
                                string_contains: 'John'
                            }
                        }
                    ]
                }
            });
        });

        test('applies multiple filters with AND logic', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({
                filters: [
                    { path: 'status', operator: '=', value: 'active' },
                    { path: 'priority', operator: '>', value: 5 }
                ]
            });

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: {
                    AND: [
                        {
                            value: {
                                path: ['status'],
                                equals: 'active'
                            }
                        },
                        {
                            value: {
                                path: ['priority'],
                                gt: 5
                            }
                        }
                    ]
                }
            });
        });

        test('combines tag and JSON filters correctly', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({
                tag: 'customer',
                filters: [{ path: 'isActive', operator: '=', value: true }]
            });

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: {
                    tags: { has: 'customer' },
                    AND: [
                        {
                            value: {
                                path: ['isActive'],
                                equals: true
                            }
                        }
                    ]
                }
            });
        });

        test('handles nested paths in filters', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({
                filters: [{ path: 'user.profile.preferences.darkMode', operator: '=', value: true }]
            });

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: {
                    AND: [
                        {
                            value: {
                                path: ['user', 'profile', 'preferences', 'darkMode'],
                                equals: true
                            }
                        }
                    ]
                }
            });
        });

        test('respects limit with filters', async () => {
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);

            await adapter.query({
                filters: [{ path: 'status', operator: '=', value: 'active' }],
                limit: 10
            });

            expect(prismaMock.agentMemoryStore.findMany).toHaveBeenCalledWith({
                where: {
                    AND: [
                        {
                            value: {
                                path: ['status'],
                                equals: 'active'
                            }
                        }
                    ]
                },
                take: 10
            });
        });

        test('throws error for invalid operator', async () => {
            await expect(
                adapter.query({
                    filters: [{ path: 'status', operator: 'INVALID' as any, value: 'active' }]
                })
            ).rejects.toThrow(/Invalid filter/);
        });

        test('throws error when orderBy is provided', async () => {
            await expect(
                adapter.query({
                    orderBy: { path: 'createdAt', direction: 'desc' }
                })
            ).rejects.toThrow(/Sorting by JSON paths not implemented/);
        });

        test('throws error for invalid path', async () => {
            await expect(
                adapter.query({
                    filters: [{ path: '', operator: '=', value: 'active' }]
                })
            ).rejects.toThrow(/Invalid filter/);
        });

        test('throws type validation error for string operators with non-string values', async () => {
            await expect(
                adapter.query({
                    filters: [{ path: 'name', operator: 'CONTAINS', value: 123 }]
                })
            ).rejects.toThrow(/CONTAINS operator requires a string value/);
        });
    });

    describe('queryByKeyPattern()', () => {
        test('returns exact match when no wildcards', async () => {
            const testData = { name: 'John Doe', status: 'active' };
            prismaMock.agentMemoryStore.findUnique.mockResolvedValue({
                key: 'user:123',
                value: testData,
                tags: [],
                createdAt: new Date(),
                updatedAt: new Date()
            });

            const results = await adapter.queryByKeyPattern('user:123');

            expect(results).toEqual([{ key: 'user:123', value: testData }]);
            expect(prismaMock.agentMemoryStore.findUnique).toHaveBeenCalledWith({
                where: { key: 'user:123' }
            });
        });

        test('returns empty array when exact match not found', async () => {
            prismaMock.agentMemoryStore.findUnique.mockResolvedValue(null);

            const results = await adapter.queryByKeyPattern('user:999');

            expect(results).toEqual([]);
        });

        test('executes raw SQL query for wildcard patterns', async () => {
            const mockResults = [
                { key: 'user:123:profile', value: { name: 'John' } },
                { key: 'user:456:profile', value: { name: 'Jane' } }
            ];
            prismaMock.$queryRaw.mockResolvedValue(mockResults);

            const results = await adapter.queryByKeyPattern('user:*:profile');

            expect(results).toEqual([
                { key: 'user:123:profile', value: { name: 'John' } },
                { key: 'user:456:profile', value: { name: 'Jane' } }
            ]);
            expect(prismaMock.$queryRaw).toHaveBeenCalledWith(
                expect.objectContaining({
                    strings: expect.arrayContaining([
                        expect.stringContaining('SELECT key, value'),
                        expect.stringContaining('WHERE key LIKE')
                    ])
                }),
                'user:%:profile'
            );
        });

        test('throws MemoryError on database error', async () => {
            const error = new Error('Database connection failed');
            prismaMock.$queryRaw.mockRejectedValue(error);

            await expect(adapter.queryByKeyPattern('user:*')).rejects.toThrow(
                expect.objectContaining({
                    message: expect.stringContaining("Failed to query keys by pattern 'user:*'")
                })
            );
        });
    });

    describe('queryByKeyPatternAdvanced()', () => {
        test('supports both * and ? wildcards', async () => {
            const mockResults = [
                { key: 'user123profile', value: { name: 'John' } },
                { key: 'userABCprofile', value: { name: 'Jane' } }
            ];
            prismaMock.$queryRaw.mockResolvedValue(mockResults);

            const results = await adapter.queryByKeyPatternAdvanced('user???profile');

            expect(results).toEqual([
                { key: 'user123profile', value: { name: 'John' } },
                { key: 'userABCprofile', value: { name: 'Jane' } }
            ]);
            expect(prismaMock.$queryRaw).toHaveBeenCalledWith(
                expect.objectContaining({
                    strings: expect.arrayContaining([
                        expect.stringContaining('SELECT key, value'),
                        expect.stringContaining('WHERE key LIKE')
                    ])
                }),
                'user___profile' // ? converted to _
            );
        });

        test('handles mixed wildcards', async () => {
            prismaMock.$queryRaw.mockResolvedValue([]);

            await adapter.queryByKeyPatternAdvanced('prefix:*:?:suffix');

            expect(prismaMock.$queryRaw).toHaveBeenCalledWith(
                expect.objectContaining({
                    strings: expect.arrayContaining([
                        expect.stringContaining('SELECT key, value'),
                        expect.stringContaining('WHERE key LIKE')
                    ])
                }),
                'prefix:%:_:suffix'
            );
        });
    });
}); 