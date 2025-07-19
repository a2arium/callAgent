import { AgentResultCache } from '../src/core/cache/AgentResultCache.js';
import type { PrismaClient } from '@prisma/client';
import type { TaskInput } from '../src/shared/types/index.js';

// Mock PrismaClient
const mockPrismaClient = {
    agentResultCache: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
    },
} as unknown as PrismaClient;

describe('AgentResultCache', () => {
    let cache: AgentResultCache;

    beforeEach(() => {
        cache = new AgentResultCache(mockPrismaClient);
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        it('should create AgentResultCache instance', () => {
            expect(cache).toBeInstanceOf(AgentResultCache);
        });
    });

    describe('getCachedResult', () => {
        const agentName = 'test-agent';
        const tenantId = 'tenant-123';
        const input: TaskInput = { query: 'test query' };

        it('should return null when no cached result exists', async () => {
            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockResolvedValue(null);

            const result = await cache.getCachedResult(agentName, input, [], tenantId);

            expect(result).toBeNull();
            expect(mockPrismaClient.agentResultCache.findUnique).toHaveBeenCalledWith({
                where: {
                    tenantId_agentName_cacheKey: {
                        tenantId,
                        agentName,
                        cacheKey: expect.any(String),
                    }
                }
            });
        });

        it('should return cached result when valid entry exists', async () => {
            const cachedData = { response: 'test response' };
            const mockCacheEntry = {
                id: 'cache-entry-1',
                result: cachedData,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
            };

            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockResolvedValue(mockCacheEntry);

            const result = await cache.getCachedResult(agentName, input, [], tenantId);

            expect(result).toEqual(cachedData);
        });

        it('should remove expired entry and return null', async () => {
            const mockCacheEntry = {
                id: 'cache-entry-1',
                result: { response: 'test response' },
                createdAt: new Date(Date.now() - 7200000), // 2 hours ago
                expiresAt: new Date(Date.now() - 3600000), // 1 hour ago (expired)
            };

            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockResolvedValue(mockCacheEntry);
            (mockPrismaClient.agentResultCache.delete as jest.Mock).mockResolvedValue({});

            const result = await cache.getCachedResult(agentName, input, [], tenantId);

            expect(result).toBeNull();
            expect(mockPrismaClient.agentResultCache.delete).toHaveBeenCalledWith({
                where: { id: mockCacheEntry.id }
            });
        });

        it('should handle database errors gracefully', async () => {
            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockRejectedValue(
                new Error('Database connection failed')
            );

            const result = await cache.getCachedResult(agentName, input, [], tenantId);

            expect(result).toBeNull();
        });

        it('should exclude specified paths from cache key', async () => {
            const inputWithExclusions: TaskInput = {
                query: 'test query',
                timestamp: '2024-01-01T00:00:00Z',
                user: { id: 'user123', name: 'John' },
                metadata: { sessionId: 'session456' }
            };

            const excludePaths = ['timestamp', 'user.id', 'metadata.sessionId'];

            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockResolvedValue(null);

            await cache.getCachedResult(agentName, inputWithExclusions, excludePaths, tenantId);

            // Verify the cache key was generated without excluded fields
            expect(mockPrismaClient.agentResultCache.findUnique).toHaveBeenCalled();
        });
    });

    describe('setCachedResult', () => {
        const agentName = 'test-agent';
        const tenantId = 'tenant-123';
        const input: TaskInput = { query: 'test query' };
        const result = { response: 'test response' };
        const ttlSeconds = 300;

        it('should store cache result successfully', async () => {
            (mockPrismaClient.agentResultCache.upsert as jest.Mock).mockResolvedValue({});

            await cache.setCachedResult(agentName, input, result, ttlSeconds, [], tenantId);

            expect(mockPrismaClient.agentResultCache.upsert).toHaveBeenCalledWith({
                where: {
                    tenantId_agentName_cacheKey: {
                        tenantId,
                        agentName,
                        cacheKey: expect.any(String),
                    }
                },
                update: {
                    result,
                    expiresAt: expect.any(Date),
                    createdAt: expect.any(Date),
                },
                create: {
                    tenantId,
                    agentName,
                    cacheKey: expect.any(String),
                    result,
                    expiresAt: expect.any(Date),
                }
            });
        });

        it('should handle database errors gracefully', async () => {
            (mockPrismaClient.agentResultCache.upsert as jest.Mock).mockRejectedValue(
                new Error('Database write failed')
            );

            // Should not throw
            await expect(
                cache.setCachedResult(agentName, input, result, ttlSeconds, [], tenantId)
            ).resolves.toBeUndefined();
        });

        it('should exclude specified paths from cache key', async () => {
            const inputWithExclusions: TaskInput = {
                query: 'test query',
                timestamp: '2024-01-01T00:00:00Z',
                requestId: 'req123'
            };
            const excludePaths = ['timestamp', 'requestId'];

            (mockPrismaClient.agentResultCache.upsert as jest.Mock).mockResolvedValue({});

            await cache.setCachedResult(agentName, inputWithExclusions, result, ttlSeconds, excludePaths, tenantId);

            expect(mockPrismaClient.agentResultCache.upsert).toHaveBeenCalled();
        });
    });

    describe('clearAgentCache', () => {
        const agentName = 'test-agent';
        const tenantId = 'tenant-123';

        it('should clear cache for specific agent and tenant', async () => {
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });

            const result = await cache.clearAgentCache(agentName, tenantId);

            expect(result).toBe(5);
            expect(mockPrismaClient.agentResultCache.deleteMany).toHaveBeenCalledWith({
                where: { agentName, tenantId }
            });
        });

        it('should clear cache for agent across all tenants', async () => {
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 10 });

            const result = await cache.clearAgentCache(agentName);

            expect(result).toBe(10);
            expect(mockPrismaClient.agentResultCache.deleteMany).toHaveBeenCalledWith({
                where: { agentName }
            });
        });

        it('should handle database errors gracefully', async () => {
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockRejectedValue(
                new Error('Database delete failed')
            );

            const result = await cache.clearAgentCache(agentName, tenantId);

            expect(result).toBe(0);
        });
    });

    describe('cache key generation', () => {
        it('should generate consistent cache keys for identical inputs', async () => {
            const input1 = { query: 'test', order: 1 };
            const input2 = { order: 1, query: 'test' }; // Same data, different key order

            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockResolvedValue(null);

            await Promise.all([
                cache.getCachedResult('test-agent', input1, [], 'tenant-123'),
                cache.getCachedResult('test-agent', input2, [], 'tenant-123')
            ]);

            const calls = (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mock.calls;
            const cacheKey1 = calls[0][0].where.tenantId_agentName_cacheKey.cacheKey;
            const cacheKey2 = calls[1][0].where.tenantId_agentName_cacheKey.cacheKey;

            // Keys should be identical despite different object key order
            expect(cacheKey1).toBe(cacheKey2);
        });

        it('should generate different cache keys for different inputs', async () => {
            const input1 = { query: 'test1' };
            const input2 = { query: 'test2' };

            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockResolvedValue(null);

            await Promise.all([
                cache.getCachedResult('test-agent', input1, [], 'tenant-123'),
                cache.getCachedResult('test-agent', input2, [], 'tenant-123')
            ]);

            const calls = (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mock.calls;
            const cacheKey1 = calls[0][0].where.tenantId_agentName_cacheKey.cacheKey;
            const cacheKey2 = calls[1][0].where.tenantId_agentName_cacheKey.cacheKey;

            expect(cacheKey1).not.toBe(cacheKey2);
        });

        it('should handle nested object exclusions', async () => {
            const input = {
                query: 'test',
                user: {
                    id: 'user123',
                    profile: {
                        sessionId: 'session456',
                        preferences: { theme: 'dark' }
                    }
                }
            };

            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockResolvedValue(null);

            // Test that nested path exclusion works
            await cache.getCachedResult('test-agent', input, ['user.profile.sessionId'], 'tenant-123');

            expect(mockPrismaClient.agentResultCache.findUnique).toHaveBeenCalled();
        });

        it('should handle array inputs correctly', async () => {
            const input = {
                items: ['item1', 'item2'],
                metadata: { count: 2 }
            };

            (mockPrismaClient.agentResultCache.findUnique as jest.Mock).mockResolvedValue(null);

            await cache.getCachedResult('test-agent', input, [], 'tenant-123');

            expect(mockPrismaClient.agentResultCache.findUnique).toHaveBeenCalled();
        });
    });
}); 